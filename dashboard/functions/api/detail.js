const NOTION_VERSION = "2025-09-03";

// 상세 기록 요청을 순차 처리해 Notion 요청이 한꺼번에 몰리지 않게 한다.
let notionQueue = Promise.resolve();
let nextNotionRequestAt = 0;

const pageContentCache = new Map();
const pageContentInFlight = new Map();

const PAGE_CACHE_TTL = 50 * 1000;
const NOTION_FETCH_TIMEOUT_MS = 12000;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeRequestId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

// Notion 요청 순차 처리 및 응답시간 측정
function pacedNotionFetch(url, options, diagnostics) {
  const queuedAt = Date.now();

  const run = async () => {
    diagnostics.queueWaitMs += Date.now() - queuedAt;

    let response;

    for (let attempt = 0; attempt < 4; attempt++) {
      const delay = Math.max(
        0,
        nextNotionRequestAt - Date.now()
      );

      if (delay) await wait(delay);

      nextNotionRequestAt = Date.now() + 400;

      const controller = new AbortController();

      const timeoutId = setTimeout(
        () => controller.abort(),
        NOTION_FETCH_TIMEOUT_MS
      );

      const requestStarted = Date.now();

      diagnostics.notionRequests++;

      try {
        response = await fetch(url, {
          ...options,
          signal: controller.signal
        });

      } catch (error) {
        diagnostics.notionElapsedMs +=
          Date.now() - requestStarted;

        diagnostics.notionLastError =
          error?.name === "AbortError"
            ? `Notion 요청 시간 초과(${NOTION_FETCH_TIMEOUT_MS / 1000}초)`
            : (error?.message || "Notion 네트워크 오류");

        diagnostics.stage = "Notion fetch";

        throw error;

      } finally {
        clearTimeout(timeoutId);
      }

      diagnostics.notionElapsedMs +=
        Date.now() - requestStarted;

      diagnostics.notionStatus = response.status;

      // 429 요청 제한 시 최대 4회 시도
      if (response.status !== 429 || attempt === 3) {
        return response;
      }

      diagnostics.notionRetries++;

      const retryAfter = Number(
        response.headers.get("Retry-After")
      );

      await wait(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * (2 ** attempt)
      );
    }

    return response;
  };

  const task = notionQueue.then(run, run);

  notionQueue = task.then(
    () => undefined,
    () => undefined
  );

  return task;
}

// Notion API 요청
async function notion(path, token, diagnostics) {
  diagnostics.stage = "Notion API 요청";

  const response = await pacedNotionFetch(
    `https://api.notion.com/v1${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION
      }
    },
    diagnostics
  );

  let data;

  try {
    data = await response.json();

  } catch (error) {
    diagnostics.stage = "Notion 응답 JSON 파싱";

    diagnostics.notionLastError =
      "Notion 응답을 JSON으로 읽지 못했습니다.";

    const parseError = new Error(
      diagnostics.notionLastError
    );

    parseError.status = response.status || 502;

    throw parseError;
  }

  if (!response.ok) {
    const error = new Error(
      data.message || `Notion API 오류: ${response.status}`
    );

    error.status = response.status;

    diagnostics.stage = "Notion HTTP 오류";
    diagnostics.notionLastError = error.message;

    throw error;
  }

  return data;
}

// Notion Rich Text 변환
function richText(value) {
  return (value || [])
    .map(item => item.plain_text || "")
    .join("");
}

// 상세 페이지 내용 및 이미지 조회
async function getPageContent(pageId, token, diagnostics) {
  const texts = [];
  const images = [];

  let cursor = null;
  let pageCount = 0;

  do {
    let path =
      `/blocks/${pageId}/children?page_size=100`;

    if (cursor) {
      path +=
        `&start_cursor=${encodeURIComponent(cursor)}`;
    }

    diagnostics.stage = "Notion 블록 조회";

    const data = await notion(
      path,
      token,
      diagnostics
    );

    pageCount++;

    for (const block of data.results || []) {
      const type = block.type;
      const content = block[type];

      if (!content) continue;

      if (content.rich_text) {
        const text = richText(content.rich_text);

        if (text) texts.push(text);
      }

      if (type === "image") {
        const imageUrl =
          content.file?.url ||
          content.external?.url;

        if (imageUrl) {
          images.push(imageUrl);
        }
      }

      if (type === "child_page") {
        texts.push(content.title || "");
      }
    }

    cursor = data.has_more
      ? data.next_cursor
      : null;

  } while (cursor);

  diagnostics.notionPages = pageCount;
  diagnostics.stage = "상세 데이터 가공 완료";

  return {
    text: texts.join("\n"),
    images
  };
}

// 진단용 응답 헤더
function diagnosticsHeaders(diagnostics) {
  return {
    "Cache-Control": "private, max-age=50",

    "X-Detail-Request-Id":
      diagnostics.requestId,

    "X-Detail-Timing":
      `total=${Date.now() - diagnostics.startedAt}ms;queue=${diagnostics.queueWaitMs}ms;notion=${diagnostics.notionElapsedMs}ms`,

    "X-Notion-Status":
      String(diagnostics.notionStatus ?? "none")
  };
}

// API 요청 처리
export async function onRequestGet({ request, env }) {
  const diagnostics = {
    requestId: makeRequestId(),
    startedAt: Date.now(),

    stage: "요청 시작",

    queueWaitMs: 0,
    notionElapsedMs: 0,

    notionRequests: 0,
    notionRetries: 0,

    notionStatus: null,
    notionPages: 0,

    notionLastError: null
  };

  try {
    const token = env.NOTION_TOKEN;

    if (!token) {
      diagnostics.stage = "환경변수 확인";

      throw new Error(
        "NOTION_TOKEN 환경변수를 확인해주세요."
      );
    }

    const url = new URL(request.url);
    const pageId = url.searchParams.get("id");

    if (!pageId) {
      diagnostics.stage = "요청 파라미터 확인";

      return Response.json(
        {
          error: "기록 ID가 없습니다.",
          diagnostics
        },
        {
          status: 400,
          headers: diagnosticsHeaders(diagnostics)
        }
      );
    }

    // 기존 상세 기록 캐시 확인
    const cached = pageContentCache.get(pageId);

    if (
      cached &&
      Date.now() - cached.savedAt < PAGE_CACHE_TTL
    ) {
      diagnostics.stage = "Cloudflare 메모리 캐시";
      diagnostics.cache = "HIT";

      return Response.json(
        {
          ...cached.content,
          diagnostics
        },
        {
          headers: diagnosticsHeaders(diagnostics)
        }
      );
    }

    // 동일 기록 중복 요청 방지
    let pending = pageContentInFlight.get(pageId);

    if (!pending) {
      diagnostics.cache = "MISS";

      pending = getPageContent(
        pageId,
        token,
        diagnostics
      )
        .then(content => {
          pageContentCache.set(pageId, {
            content,
            savedAt: Date.now()
          });

          return content;
        })
        .finally(() => {
          pageContentInFlight.delete(pageId);
        });

      pageContentInFlight.set(pageId, pending);

    } else {
      diagnostics.cache = "IN_FLIGHT";
    }

    diagnostics.stage =
      diagnostics.cache === "IN_FLIGHT"
        ? "동일 기록 조회 대기"
        : diagnostics.stage;

    const content = await pending;

    diagnostics.stage = "응답 생성 완료";

    return Response.json(
      {
        ...content,
        diagnostics
      },
      {
        headers: diagnosticsHeaders(diagnostics)
      }
    );

  } catch (error) {
    const status =
      Number(error.status) ||
      (error?.name === "AbortError" ? 504 : 502);

    diagnostics.error =
      error.message || "상세 기록 조회 실패";

    diagnostics.stage =
      diagnostics.stage || "상세 기록 조회 실패";

    const headers = diagnosticsHeaders(diagnostics);

    if (status === 429) {
      headers["Retry-After"] = "2";
    }

    return Response.json(
      {
        error: diagnostics.error,
        diagnostics
      },
      {
        status:
          status >= 400 && status <= 599
            ? status
            : 500,
        headers
      }
    );
  }
}
