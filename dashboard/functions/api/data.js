const NOTION_VERSION = "2025-09-03";
const PAGE_SIZE = 100;
const DATA_CACHE_TTL = 60;

let cachedDataSourceId = null;
let cachedRootId = null;

async function notion(path, token, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data.message || `Notion API 오류: ${response.status}`
    );
    error.status = response.status;
    throw error;
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

function getCategory(title) {
  const value = (title || "").trim();

  if (value.includes("앨범")) return "앨범";
  if (value.includes("알림장")) return "알림장";
  if (value.includes("공지")) return "공지";

  return "전체";
}

async function findDataSource(rootId, token) {
  if (cachedDataSourceId && cachedRootId === rootId) {
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
    throw new Error("상위 페이지에서 데이터베이스를 찾지 못했습니다.");
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

  return {
    items: (result.results || []).map(page => {
      const title = getTitle(page);

      return {
        id: page.id,
        title,
        date: getDate(page),
        category: getCategory(title)
      };
    }),
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

    const requestUrl = new URL(request.url);
    const cursor = requestUrl.searchParams.get("cursor");

    // 가족이 동시에 접속하거나 새로고침할 때
    // 동일한 Notion 목록을 반복 조회하지 않도록 엣지 캐시 사용
    const cache = caches.default;

    const cacheKeyUrl = new URL(request.url);
    cacheKeyUrl.searchParams.sort();

    const cacheKey = new Request(
      cacheKeyUrl.toString(),
      { method: "GET" }
    );

    const cached = await cache.match(cacheKey);

    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("X-Dashboard-Data-Cache", "HIT");

      return new Response(cached.body, {
        status: cached.status,
        headers
      });
    }

    const data = await fetchDashboardData(
      token,
      rootId,
      cursor
    );

    const response = Response.json(data, {
      headers: {
        "Cache-Control": `public, max-age=0, s-maxage=${DATA_CACHE_TTL}`,
        "X-Dashboard-Data-Cache": "MISS"
      }
    });

    await cache.put(cacheKey, response.clone());

    return response;

  } catch (error) {
    const status = Number(error.status) || 500;
    const headers = {};

    if (status === 429) {
      headers["Retry-After"] = "2";
    }

    return Response.json(
      {
        error: error.message || "데이터를 불러오지 못했습니다."
      },
      {
        status: status >= 400 && status <= 599 ? status : 500,
        headers
      }
    );
  }
}
