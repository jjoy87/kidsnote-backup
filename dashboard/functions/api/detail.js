const NOTION_VERSION = "2025-09-03";

// 상세 기록 재조회와 동시에 몰리는 Notion 요청을 제한한다.
let notionQueue = Promise.resolve();
let nextNotionRequestAt = 0;

const pageContentCache = new Map();
const pageContentInFlight = new Map();

const PAGE_CACHE_TTL = 50 * 1000;
const NOTION_FETCH_TIMEOUT_MS = 7000;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Notion 요청 간격 제어 및 일시적 오류 재시도
function pacedNotionFetch(url, options = {}) {
  const run = async () => {
    let lastError;

    for (let attempt = 0; attempt < 2; attempt++) {
      const delay = Math.max(0, nextNotionRequestAt - Date.now());

      if (delay) await wait(delay);

      nextNotionRequestAt = Date.now() + 400;

      const controller = new AbortController();

      const timeoutId = setTimeout(
        () => controller.abort(),
        NOTION_FETCH_TIMEOUT_MS
      );

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });

        if (response.status === 429 && attempt === 0) {
          const retryAfter = Number(
            response.headers.get("Retry-After")
          );

          const retryMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 1500)
              : 1000;

          await wait(retryMs);
          continue;
        }

        if (
          [500, 502, 503, 504].includes(response.status) &&
          attempt === 0
        ) {
          await wait(500);
          continue;
        }

        return response;

      } catch (error) {
        lastError = error;

        if (attempt === 0) {
          await wait(500);
          continue;
        }

        if (error.name === "AbortError") {
          throw new Error(
            `Notion 응답 시간 초과(${NOTION_FETCH_TIMEOUT_MS / 1000}초)`
          );
        }

        throw error;

      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (lastError) throw lastError;

    throw new Error("Notion API 요청 실패");
  };

  const task = notionQueue.then(run, run);

  notionQueue = task.then(
    () => undefined,
    () => undefined
  );

  return task;
}

// Notion API 호출
async function notion(path, token) {
  const response = await pacedNotionFetch(
    `https://api.notion.com/v1${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION
      }
    }
  );

  const raw = await response.text();

  let data;

  try {
    data = JSON.parse(raw);

  } catch (_) {
    const error = new Error(
      `Notion 응답 JSON 파싱 실패 (HTTP ${response.status})`
    );

    error.status = response.status;

    throw error;
  }

  if (!response.ok) {
    const error = new Error(
      data.message || `Notion API 오류: ${response.status}`
    );

    error.status = response.status;

    throw error;
  }

  return data;
}

// Notion 텍스트 추출
function richText(value) {
  return (value || [])
    .map(item => item.plain_text || "")
    .join("");
}

// 페이지 상세 내용 및 사진 조회
async function getPageContent(pageId, token) {
  const texts = [];
  const images = [];

  let cursor = null;
  let pageCount = 0;

  do {
    if (++pageCount > 20) {
      throw new Error(
        "상세 기록 페이지가 너무 많아 조회를 중단했습니다."
      );
    }

    let path = `/blocks/${pageId}/children?page_size=100`;

    if (cursor) {
      path += `&start_cursor=${encodeURIComponent(cursor)}`;
    }

    const data = await notion(path, token);

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

        if (imageUrl) images.push(imageUrl);
      }

      if (type === "child_page") {
        texts.push(content.title || "");
      }
    }

    cursor = data.has_more
      ? data.next_cursor
      : null;

  } while (cursor);

  return {
    text: texts.join("\n"),
    images
  };
}

// Cloudflare Pages API
export async function onRequestGet({ request, env }) {
  const startedAt = Date.now();

  try {
    const token = env.NOTION_TOKEN;

    if (!token) {
      throw new Error(
        "NOTION_TOKEN 환경변수를 확인해주세요."
      );
    }

    const url = new URL(request.url);
    const pageId = url.searchParams.get("id");

    if (!pageId) {
      return Response.json(
        { error: "기록 ID가 없습니다." },
        { status: 400 }
      );
    }

    // 캐시 확인
    const cached = pageContentCache.get(pageId);

    if (
      cached &&
      Date.now() - cached.savedAt < PAGE_CACHE_TTL
    ) {
      return Response.json(cached.content, {
        headers: {
          "Cache-Control": "private, max-age=50",
          "X-Detail-Cache": "HIT",
          "X-Detail-Time": String(Date.now() - startedAt)
        }
      });
    }

    // 동일 페이지 동시 요청 중복 방지
    let pending = pageContentInFlight.get(pageId);

    if (!pending) {
      pending = getPageContent(pageId, token)
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
    }

    const content = await pending;

    return Response.json(content, {
      headers: {
        "Cache-Control": "private, max-age=50",
        "X-Detail-Cache": "MISS",
        "X-Detail-Time": String(Date.now() - startedAt)
      }
    });

  } catch (error) {
    const status = Number(error.status) || 500;

    const headers = {
      "X-Detail-Time": String(Date.now() - startedAt)
    };

    if (status === 429) {
      headers["Retry-After"] = "2";
    }

    return Response.json(
      {
        error: error.message || "상세 기록 조회 실패"
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
