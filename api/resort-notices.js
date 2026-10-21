import { authenticateRequest, jsonResponse } from './push.js';

const RESORT_ORIGIN = 'https://www.jisanresort.co.kr';
const NOTICE_LIST_URL = `${RESORT_ORIGIN}/w/event/notice.asp`;

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .trim();
}

function textFromHtml(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

function getClassContent(html, className) {
  const escapedClass = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*class=["'][^"']*\\b${escapedClass}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i'
  ));
  return match ? match[2] : '';
}

function getAttribute(tag, attribute) {
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${escapedAttribute}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? decodeHtml(match[1]) : '';
}

function getImageUrl(path) {
  if (!path || !path.startsWith('/downloads/notice/')) return '';
  return new URL(path, RESORT_ORIGIN).href;
}

function parseNotices(html) {
  const notices = [];
  const anchorPattern = /<a\b(?=[^>]*\bonclick=["']web\.pageMove\(['"]board_view\.asp['"],['"]board_sw=notice,seq=(\d+)['"]\)["'])[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html))) {
    const cardHtml = match[2];
    const title = textFromHtml(getClassContent(cardHtml, 'tit'));
    const date = textFromHtml(getClassContent(cardHtml, 'date'));
    const category = textFromHtml(getClassContent(cardHtml, 'label'));
    const imageTag = cardHtml.match(/<img\b[^>]*>/i)?.[0] || '';
    const imageUrl = getImageUrl(getAttribute(imageTag, 'src'));
    if (!title || !match[1]) continue;

    notices.push({
      id: match[1],
      title,
      date,
      category,
      imageUrl
    });
  }
  return notices;
}

function parseTotalPages(html) {
  const pagePattern = /page=(\d+)/g;
  let maximumPage = 1;
  let match;
  while ((match = pagePattern.exec(html))) {
    maximumPage = Math.max(maximumPage, Number(match[1]));
  }
  return maximumPage;
}

async function fetchResortPage(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0 (compatible; JisanSecurityNoticeViewer/1.0)'
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`지산리조트 공지 페이지 조회 실패 (HTTP ${response.status})`);
  return response.text();
}

export async function handleListResortNotices(request, supabaseAdmin) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;

    const requestedPage = Number(new URL(request.url).searchParams.get('page') || 1);
    if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 1000) {
      return jsonResponse({ error: '공지 페이지 번호가 올바르지 않습니다.' }, 400);
    }

    const url = new URL(NOTICE_LIST_URL);
    if (requestedPage > 1) url.searchParams.set('page', String(requestedPage));
    const html = await fetchResortPage(url);
    const totalPages = parseTotalPages(html);
    const page = Math.min(requestedPage, totalPages);
    return jsonResponse({ page, totalPages, notices: parseNotices(html) });
  } catch (error) {
    console.error('지산리조트 공지 목록 조회 오류:', error);
    return jsonResponse({ error: error.message || '공지사항을 불러오지 못했습니다.' }, 502);
  }
}

export async function handleGetResortNotice(request, supabaseAdmin, noticeId) {
  try {
    const auth = await authenticateRequest(request, supabaseAdmin);
    if (auth.error) return auth.error;
    if (!/^\d{1,10}$/.test(noticeId)) {
      return jsonResponse({ error: '공지 번호가 올바르지 않습니다.' }, 400);
    }

    const url = new URL('/w/event/board_view.asp', RESORT_ORIGIN);
    url.searchParams.set('board_sw', 'notice');
    url.searchParams.set('seq', noticeId);
    const html = await fetchResortPage(url);
    const titleHtml = getClassContent(getClassContent(html, 'view_table_tit'), 'fs36');
    const title = textFromHtml(titleHtml);
    const dateHtml = getClassContent(getClassContent(html, 'view_table_tit'), 'f_right');
    const date = textFromHtml(dateHtml).replace(/^등록일\s*/, '');
    if (!title) return jsonResponse({ error: '공지 내용을 찾을 수 없습니다.' }, 404);

    const imageArea = getClassContent(html, 'img_area');
    const images = [...imageArea.matchAll(/<img\b[^>]*>/gi)]
      .map(image => getImageUrl(getAttribute(image[0], 'src')))
      .filter(Boolean);
    return jsonResponse({ id: noticeId, title, date, images });
  } catch (error) {
    console.error('지산리조트 공지 상세 조회 오류:', error);
    return jsonResponse({ error: error.message || '공지 내용을 불러오지 못했습니다.' }, 502);
  }
}
