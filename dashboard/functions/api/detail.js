const NOTION_VERSION = "2025-09-03";

async function notion(path, token) {
  const response = await fetch(
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

    const content = await getPageContent(pageId, token);

    return Response.json(content, {
      headers: {
        "Cache-Control": "private, max-age=60"
      }
    });

  } catch (error) {
    return Response.json(
      { error: error.message || "상세 기록 조회 실패" },
      { status: 500 }
    );
  }
}
