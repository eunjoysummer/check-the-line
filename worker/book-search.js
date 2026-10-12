// 네이버 책 검색 프록시 (Cloudflare Worker)
// 설정: Worker → 설정 → 변수 및 비밀
//   NAVER_ID (비밀), NAVER_SECRET (비밀), ALLOW_ORIGIN (예: https://내앱.pages.dev, 여러 개면 쉼표)
export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allow = (env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const ok = allow.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': ok ? origin : (allow[0] || ''),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!ok) return new Response('forbidden', { status: 403, headers: cors });

    const q = (new URL(req.url).searchParams.get('q') || '').trim();
    if (q.length < 2) return Response.json({ items: [] }, { headers: cors });

    const r = await fetch('https://openapi.naver.com/v1/search/book.json?display=10&query=' + encodeURIComponent(q), {
      headers: { 'X-Naver-Client-Id': env.NAVER_ID, 'X-Naver-Client-Secret': env.NAVER_SECRET }
    });
    if (!r.ok) return Response.json({ error: r.status }, { status: 502, headers: cors });

    const d = await r.json();
    const strip = s => (s || '').replace(/<[^>]+>/g, '');
    const items = (d.items || []).map(b => ({
      title: strip(b.title),
      author: strip(b.author).replace(/\^/g, ', '),
      publisher: strip(b.publisher),
      pubdate: b.pubdate || '',
      isbn: (b.isbn || '').split(' ').pop(),
      image: b.image || '',
      link: b.link || ''
    }));
    return Response.json({ items }, { headers: { ...cors, 'Cache-Control': 'public, max-age=86400' } });
  }
};
