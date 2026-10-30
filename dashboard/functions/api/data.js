
const NOTION_VERSION = "2025-09-03";

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
    throw new Error(data.message || `Notion API error: ${response.status}`);
  }

  return data;
}

function richText(value) {
  return (value || []).map(item => item.plain_text || "").join("");
}

function getTitle(page) {
  const props = page.properties || {};

  for (const value of Object.values(props)) {
    if (value.type === "title") return richText(value.title);
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
  if (title.includes("앨범")) return "앨범";
  if (title.includes("공지")) return "공지";
  if (title.includes("알림장")) return "알림장";
  return "전체";
}

async function getBlocks(blockId, token) {
  let results = [];
  let cursor = "";

  do {
    const query = cursor ? `?start_cursor=${cursor}` : "";
    const data = await notion(
      `/blocks/${blockId}/children${query}`,
      token
    );

    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : "";
  } while (cursor);

  return results;
}

async function getPageContent(pageId, token) {
  const blocks = await getBlocks(pageId, token);
  const texts = [];
  const images = [];

  for (const block of blocks) {
    const type = block.type;
    const content = block[type];

    if (!content) continue;

    if (content.rich_text) {
      const text = richText(content.rich_text);
      if (text) texts.push(text);
    }

    if (type === "image") {
      const url = content.file?.url || content.external?.url;
      if (url) images.push(url);
    }

    if (type === "child_page") {
      texts.push(content.title || "");
    }

    if (block.has_children) {
      const childBlocks = await getBlocks(block.id, token);

      for (const child of childBlocks) {
        const childContent = child[child.type];

        if (childContent?.rich_text) {
          const text = richText(childContent.rich_text);
          if (text) texts.push(text);
        }

        if (child.type === "image") {
          const url =
            childContent.file?.url || childContent.external?.url;
          if (url) images.push(url);
        }
      }
    }
  }

  return { text: texts.join("\n"), images };
}

async function findDataSource(rootId, token) {
  // 먼저 입력한 ID가 데이터베이스인지 확인
  try {
    const database = await notion(`/databases/${rootId}`, token);
    if (database.data_sources?.length) {
      return database.data_sources[0].id;
    }
  } catch (_) {}

  // 데이터베이스가 아니라면 상위 페이지에서 찾기
  const blocks = await getBlocks(rootId, token);
  const childDatabase = blocks.find(
    block => block.type === "child_database"
  );

  if (!childDatabase) {
    throw new Error(
      "상위 페이지에서 데이터베이스를 찾지 못했습니다. Notion 연결 권한과 페이지 ID를 확인해주세요."
    );
  }

  const database = await notion(
    `/databases/${childDatabase.id}`,
    token
  );

  if (!database.data_sources?.length) {
    throw new Error("Notion 데이터 소스를 찾지 못했습니다.");
  }

  return database.data_sources[0].id;
}

export async function onRequestGet({ env }) {
  try {
    const token = env.NOTION_TOKEN;
    const rootId = env.NOTION_ROOT_PAGE_ID;

    if (!token || !rootId) {
      return Response.json(
        { error: "Cloudflare 환경변수 설정이 필요합니다." },
        { status: 500 }
      );
    }

    const dataSourceId = await findDataSource(rootId, token);

    const result = await notion(
      `/data_sources/${dataSourceId}/query`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          page_size: 100,
          sorts: [{ timestamp: "created_time", direction: "descending" }]
        })
      }
    );

    const items = [];

    for (const page of result.results || []) {
      const title = getTitle(page);
      const content = await getPageContent(page.id, token);

      items.push({
        id: page.id,
        title,
        date: getDate(page),
        category: getCategory(title),
        text: content.text,
        images: content.images
      });
    }

    return Response.json(
      { items },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    return Response.json(
      { error: error.message || "데이터를 불러오지 못했습니다." },
      { status: 500 }
    );
  }
}
