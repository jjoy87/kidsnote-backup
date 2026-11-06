const NOTION_VERSION = "2025-09-03";

// 상세 기록 재조회와 동시에 몰리는 Notion 요청을 제한한다.
let notionQueue = Promise.resolve();
let nextNotionRequestAt = 0;
const pageContentCache = new Map();
const pageContentInFlight = new Map();
const PAGE_CACHE_TTL = 50 * 1000;

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

async function getPageContent(pageId, token) {
  const texts = [];
  const images = [];

  let cursor = null;

  do {
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

    cursor = data.has_more ? data.next_cursor : null;

  } while (cursor);

  return {
    text: texts.join("\n"),
    images
  };
}

export async function onRequestGet({ request, env }) {
  try {
    const token = env.NOTION_TOKEN;

    if (!token) {
      throw new Error("NOTION_TOKEN 환경변수를 확인해주세요.");
    }

    const url = new URL(request.url);
    const pageId = url.searchParams.get("id");

    if (!pageId) {
      return Response.json(
        { error: "기록 ID가 없습니다." },
        { status: 400 }
      );
    }

    const cached = pageContentCache.get(pageId);
    if (cached && Date.now() - cached.savedAt < PAGE_CACHE_TTL) {
      return Response.json(cached.content, {
        headers: { "Cache-Control": "private, max-age=50" }
      });
    }

    let pending = pageContentInFlight.get(pageId);
    if (!pending) {
      pending = getPageContent(pageId, token).then(content => {
        pageContentCache.set(pageId, { content, savedAt: Date.now() });
        return content;
      }).finally(() => pageContentInFlight.delete(pageId));
      pageContentInFlight.set(pageId, pending);
    }

    const content = await pending;

    return Response.json(content, {
      headers: {
        "Cache-Control": "private, max-age=50"
      }
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
