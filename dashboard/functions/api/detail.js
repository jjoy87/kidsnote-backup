const NOTION_VERSION = "2025-09-03";

// 요청을 직렬로 묶지 않고, 시작 시점만 400ms 간격으로 분산한다.
// 기존 직렬 큐는 성장 여행의 2개 worker 요청을 한 줄로 세워
// 브라우저 타임아웃보다 대기 시간이 길어지는 원인이 될 수 있다.
let nextNotionRequestAt = 0;
const pageContentCache = new Map();
const pageContentInFlight = new Map();
const PAGE_CACHE_TTL = 50 * 1000;
const NOTION_FETCH_TIMEOUT_MS = 12000;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pacedNotionFetch(url, options = {}) {
  let response;

  for (let attempt = 0; attempt < 2; attempt++) {
    // 예약은 동기적으로 수행하고, 실제 fetch는 서로 겹쳐 실행할 수 있게 한다.
    const scheduledAt = Math.max(Date.now(), nextNotionRequestAt);
    nextNotionRequestAt = scheduledAt + 400;
    const delay = scheduledAt - Date.now();
    if (delay > 0) await wait(delay);

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      NOTION_FETCH_TIMEOUT_MS
    );

    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } catch (error) {
      if (attempt === 0) {
        await wait(500);
        continue;
      }
      if (error.name === "AbortError") {
        throw new Error(`Notion 응답 시간 초과(${NOTION_FETCH_TIMEOUT_MS / 1000}초)`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt === 0 && (response.status === 429 ||
        [500, 502, 503, 504].includes(response.status))) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const retryDelay = response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 3000)
        : 700;
      await wait(retryDelay);
      continue;
    }

    return response;
  }

  return response;
}

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

  let data;
  try {
    data = await response.json();
  } catch (_) {
    const error = new Error(`Notion 응답 JSON 파싱 실패 (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(data.message || `Notion API 오류: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function richText(value) {
  return (value || []).map(item => item.plain_text || "").join("");
}

async function getPageContent(pageId, token) {
  const texts = [];
  const images = [];
  let cursor = null;

  do {
    let path = `/blocks/${pageId}/children?page_size=100`;
    if (cursor) path += `&start_cursor=${encodeURIComponent(cursor)}`;

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
        const imageUrl = content.file?.url || content.external?.url;
        if (imageUrl) images.push(imageUrl);
      }

      if (type === "child_page") texts.push(content.title || "");
    }

    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  return { text: texts.join("\n"), images };
}

export async function onRequestGet({ request, env }) {
  try {
    const token = env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN 환경변수를 확인해주세요.");

    const url = new URL(request.url);
    const pageId = url.searchParams.get("id");
    if (!pageId) {
      return Response.json({ error: "기록 ID가 없습니다." }, { status: 400 });
    }

    const cached = pageContentCache.get(pageId);
    if (cached && Date.now() - cached.savedAt < PAGE_CACHE_TTL) {
      return Response.json(cached.content, {
        headers: { "Cache-Control": "private, max-age=50" }
      });
    }

    let pending = pageContentInFlight.get(pageId);
    if (!pending) {
      pending = getPageContent(pageId, token)
        .then(content => {
          pageContentCache.set(pageId, { content, savedAt: Date.now() });
          return content;
        })
        .finally(() => pageContentInFlight.delete(pageId));

      pageContentInFlight.set(pageId, pending);
    }

    const content = await pending;
    return Response.json(content, {
      headers: { "Cache-Control": "private, max-age=50" }
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    const headers = {};
    if (status === 429) headers["Retry-After"] = "2";

    return Response.json(
      { error: error.message || "상세 기록 조회 실패" },
      { status: status >= 400 && status <= 599 ? status : 500, headers }
    );
  }
}
