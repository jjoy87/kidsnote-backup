const NOTION_VERSION = "2025-09-03";

const PAGE_SIZE = 15;
const CACHE_TTL = 60 * 1000;
const REQUEST_INTERVAL = 400;

// 캐시
let cachedPayload = null;
let cachedAt = 0;
let inFlight = null;

let cachedDataSourceId = null;
let cachedRootId = null;

// 요청 간격 제어
let nextRequestAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function paceRequest() {
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);

  nextRequestAt = Math.max(now, nextRequestAt) + REQUEST_INTERVAL;

  if (wait > 0) {
    await sleep(wait);
  }
}

// Notion API 요청
async function notion(path, token, options = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await paceRequest();

    const response = await fetch(
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

    if (response.ok) {
      return data;
    }

    const error = new Error(
      data.message || `Notion API error: ${response.status}`
    );

    error.status = response.status;

    if (
      attempt === 0 &&
      (response.status === 429 || response.status >= 500)
    ) {
      const retryAfter = Number(
        response.headers.get("Retry-After")
      );

      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1500
      );

      continue;
    }

    throw error;
  }
}

// 텍스트 추출
function richText(value) {
  return (value || [])
    .map(item => item.plain_text || "")
    .join("");
}

// 제목 추출
function getTitle(page) {
  const props = page.properties || {};

  for (const value of Object.values(props)) {
    if (value.type === "title") {
      return richText(value.title);
    }
  }

  return "제목 없음";
}

// 날짜 추출
function getDate(page) {
  const props = page.properties || {};

  for (const value of Object.values(props)) {
    if (value.type === "date" && value.date?.start) {
      return value.date.start;
    }
  }

  return page.created_time || "";
}

// 카테고리 구분
function getCategory(title) {
  if (title.includes("앨범")) return "앨범";
  if (title.includes("공지")) return "공지";
  if (title.includes("알림장")) return "알림장";

  return "전체";
}

// 상위 페이지에서 데이터베이스 찾기
async function findDataSource(rootId, token) {

  if (
    cachedDataSourceId &&
    cachedRootId === rootId
  ) {
    return cachedDataSourceId;
  }

  // 상위 페이지의 하위 블록 조회
  const blocks = await notion(
    `/blocks/${rootId}/children?page_size=100`,
    token
  );

  // 데이터베이스 블록 찾기
  const childDatabase = (blocks.results || []).find(
    block => block.type === "child_database"
  );

  if (!childDatabase) {
    throw new Error(
      "상위 페이지에서 데이터베이스를 찾지 못했습니다. Notion 연결 권한을 확인해주세요."
    );
  }

  // 실제 데이터베이스 정보 조회
  const database = await notion(
    `/databases/${childDatabase.id}`,
    token
  );

  const dataSourceId = database.data_sources?.[0]?.id;

  if (!dataSourceId) {
    throw new Error(
      "Notion 데이터 소스를 찾지 못했습니다."
    );
  }

  cachedDataSourceId = dataSourceId;
  cachedRootId = rootId;

  return dataSourceId;
}

// 페이지 본문 및 사진 가져오기
async function getPageContent(pageId, token) {

  const data = await notion(
    `/blocks/${pageId}/children?page_size=100`,
    token
  );

  const texts = [];
  const images = [];

  for (const block of data.results || []) {

    const type = block.type;
    const content = block[type];

    if (!content) continue;

    // 텍스트
    if (content.rich_text) {
      const text = richText(content.rich_text);

      if (text) {
        texts.push(text);
      }
    }

    // 사진
    if (type === "image") {
      const url =
        content.file?.url ||
        content.external?.url;

      if (url) {
        images.push(url);
      }
    }

    // 하위 페이지 제목
    if (type === "child_page") {
      texts.push(content.title || "");
    }
  }

  return {
    text: texts.join("\n"),
    images
  };
}

// 대시보드 데이터 가져오기
async function fetchDashboardData(token, rootId) {

  // 데이터베이스 찾기
  const dataSourceId = await findDataSource(
    rootId,
    token
  );

  // 최신 기록 조회
  const result = await notion(
    `/data_sources/${dataSourceId}/query`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        page_size: PAGE_SIZE,
        sorts: [
          {
            timestamp: "created_time",
            direction: "descending"
          }
        ]
      })
    }
  );

  const items = [];

  // 기록별 본문 가져오기
  for (const page of result.results || []) {

    const title = getTitle(page);

    const content = await getPageContent(
      page.id,
      token
    );

    items.push({
      id: page.id,
      title,
      date: getDate(page),
      category: getCategory(title),
      text: content.text,
      images: content.images
    });
  }

  return {
    items,
    total: items.length
  };
}

// API 실행
export async function onRequestGet({ env }) {

  try {

    const token = env.NOTION_TOKEN;
    const rootId = env.NOTION_ROOT_PAGE_ID;

    if (!token || !rootId) {
      return Response.json(
        {
          error: "Cloudflare 환경변수 설정이 필요합니다."
        },
        { status: 500 }
      );
    }

    // 60초 캐시 확인
    if (
      cachedPayload &&
      Date.now() - cachedAt < CACHE_TTL
    ) {
      return Response.json(cachedPayload, {
        headers: {
          "Cache-Control": "private, max-age=60"
        }
      });
    }

    // 중복 실행 방지
    if (!inFlight) {

      inFlight = fetchDashboardData(
        token,
        rootId
      )
        .then(data => {

          cachedPayload = data;
          cachedAt = Date.now();

          return data;

        })
        .finally(() => {
          inFlight = null;
        });
    }

    const payload = await inFlight;

    return Response.json(payload, {
      headers: {
        "Cache-Control": "private, max-age=60"
      }
    });

  } catch (error) {

    return Response.json(
      {
        error:
          error.message ||
          "데이터를 불러오지 못했습니다."
      },
      { status: 500 }
    );

  }
}
