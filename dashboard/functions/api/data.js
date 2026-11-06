const NOTION_VERSION = "2025-09-03";
const PAGE_SIZE = 100;

let cachedDataSourceId = null;
let cachedRootId = null;

// Notion integration은 평균 초당 약 3회 제한이 있으므로 요청 간격을 두고,
// 429 응답은 Retry-After를 우선 존중해 재시도한다.
let notionQueue = Promise.resolve();
let nextNotionRequestAt = 0;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pacedNotionFetch(url, options) {
  const run = async () => {
    let response;
    for (let attempt = 0; attempt < 4; attempt++) {
      const delay = Math.max(0, nextNotionRequestAt - Date.now());
      if (delay) await wait(delay);
      nextNotionRequestAt = Date.now() + 400;

      response = await fetch(url, options);
      if (response.status !== 429 || attempt === 3) return response;

      const retryAfter = Number(response.headers.get("Retry-After"));
      await wait(Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * (2 ** attempt));
    }
    return response;
  };

  const task = notionQueue.then(run, run);
  notionQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function notion(path, token, options = {}) {
  const response = await pacedNotionFetch(
    `https://api.notion.com/v1${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.message || `Notion API 오류: ${response.status}`
    );
  }

  return data;
}

function richText(value) {
  return (value || [])
    .map(item => item.plain_text || "")
    .join("");
}

function getTitle(page) {
  const props = page.properties || {};

  for (const value of Object.values(props)) {
    if (value.type === "title") {
      return richText(value.title);
    }
  }

  return "제목 없음";
}

function getDate(page) {
  const props = page.properties || {};

  for (const value of Object.values(props)) {
    if (value.type === "date" && value.date?.start) {
      return value.date.start;
    }
  }

  return page.created_time || "";
}

// 카테고리 분류
function getCategory(title) {
  const value = (title || "").trim();

  // 알림장 제목에 '공지'라는 단어가 포함될 수 있으므로
  // 알림장을 공지보다 먼저 판별
  if (value.includes("앨범")) return "앨범";
  if (value.includes("알림장")) return "알림장";
  if (value.includes("공지")) return "공지";

  return "전체";
}

async function findDataSource(rootId, token) {
  if (
    cachedDataSourceId &&
    cachedRootId === rootId
  ) {
    return cachedDataSourceId;
  }

  const blocks = await notion(
    `/blocks/${rootId}/children?page_size=100`,
    token
  );

  const childDatabase = (blocks.results || []).find(
    block => block.type === "child_database"
  );

  if (!childDatabase) {
    throw new Error(
      "상위 페이지에서 데이터베이스를 찾지 못했습니다."
    );
  }

  const database = await notion(
    `/databases/${childDatabase.id}`,
    token
  );

  const dataSourceId = database.data_sources?.[0]?.id;

  if (!dataSourceId) {
    throw new Error("Notion 데이터 소스를 찾지 못했습니다.");
  }

  cachedDataSourceId = dataSourceId;
  cachedRootId = rootId;

  return dataSourceId;
}

async function fetchDashboardData(token, rootId, cursor) {
  const dataSourceId = await findDataSource(rootId, token);

  const body = {
    page_size: PAGE_SIZE,
    sorts: [
      {
        timestamp: "created_time",
        direction: "descending"
      }
    ]
  };

  if (cursor) {
    body.start_cursor = cursor;
  }

  const result = await notion(
    `/data_sources/${dataSourceId}/query`,
    token,
    {
      method: "POST",
      body: JSON.stringify(body)
    }
  );

  const items = (result.results || []).map(page => {
    const title = getTitle(page);

    return {
      id: page.id,
      title,
      date: getDate(page),
      category: getCategory(title)
    };
  });

  return {
    items,
    has_more: result.has_more,
    next_cursor: result.next_cursor
  };
}

export async function onRequestGet({ request, env }) {
  try {
    const token = env.NOTION_TOKEN;
    const rootId = env.NOTION_ROOT_PAGE_ID;

    if (!token || !rootId) {
      return Response.json(
        { error: "Cloudflare 환경변수를 확인해주세요." },
        { status: 500 }
      );
    }

    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");

    const data = await fetchDashboardData(
      token,
      rootId,
      cursor
    );

    return Response.json(data, {
      headers: {
        "Cache-Control": "private, max-age=30"
      }
    });

  } catch (error) {
    return Response.json(
      {
        error: error.message || "데이터를 불러오지 못했습니다."
      },
      { status: 500 }
    );
  }
}
