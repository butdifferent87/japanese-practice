// 비행기 모드에서도 열리게 하는 서비스 워커 (공개본 전용 — index.html 이 https 에서만 등록한다).
//
// 원칙: 인터넷이 되면 **항상 네트워크(최신 배포)를 먼저** 쓰고, 안 되면 폰에 받아 둔 사본을 쓴다.
// 사본을 먼저 쓰면 새로 배포한 노트가 옛 화면에 갇힌다 — 그게 이 장치의 흔한 사고라 피한다.
//
// 받아 둘 목록은 deploy.sh 가 만드는 offline-manifest.json 이다. 파일마다 내용 해시(rev)가 있어
// **바뀐 파일만** 다시 받는다 — 통화 음성(수십 MB)을 배포 때마다 통째로 받지 않게.
// 사본은 이 목록이 바꿀 때만 갱신한다(평소 응답을 끼워 넣지 않음) — 어느 판이 들어 있는지 rev 로 늘 알 수 있게.
const CACHE = 'jp-offline-v1';
const MANIFEST = 'offline-manifest.json';
const NET_TIMEOUT = 4000;   // 기내 와이파이처럼 붙긴 했는데 응답이 안 오는 경우, 4초 뒤 사본으로

const abs = u => new URL(u, self.registration.scope).href;

// 설치 때는 화면에 꼭 필요한 것(core)만 받는다. 실패하면 설치 자체를 포기 — 반쪽 사본으로 열리는 것보다 낫다.
self.addEventListener('install', e => {
  e.waitUntil(syncFiles(false).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});
// 음성 같은 큰 파일은 화면이 열린 뒤 페이지가 'prefetch' 를 보내면 받는다.
// activate 안에서 받으면 그동안 모든 요청이 대기해 화면이 멈춘다.
self.addEventListener('message', e => {
  if (e.data === 'prefetch') e.waitUntil(syncFiles(true).catch(() => {}));
});

async function syncFiles(all) {
  const m = await (await fetch(MANIFEST, { cache: 'no-store' })).json();
  const cache = await caches.open(CACHE);
  for (const f of m.files) {
    if (!all && !f.core) continue;
    const hit = await cache.match(abs(f.url));
    if (hit && hit.headers.get('x-rev') === f.rev) continue;
    try {
      const r = await fetch(f.url, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const headers = new Headers(r.headers);
      headers.set('x-rev', f.rev);
      await cache.put(abs(f.url), new Response(await r.blob(), { status: 200, headers }));
    } catch (err) {
      if (f.core) throw err;     // 음성 하나 실패는 넘어간다 — 다음에 열 때 다시 받는다
    }
  }
  // 목록에서 빠진 파일(지운 노트 등)은 폰에서도 지운다
  if (all) {
    const keep = new Set(m.files.map(f => abs(f.url)));
    for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' && req.method !== 'HEAD') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // 유튜브·동기화 서버는 손대지 않는다
  if (url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/' + MANIFEST)) return;
  e.respondWith(handle(req, url));
});

async function handle(req, url) {
  // 주소 끝이 / 면 index.html. ?쿼리·#해시는 사본 찾을 때 무시한다.
  const key = url.pathname.endsWith('/') ? abs('index.html') : url.origin + url.pathname;
  const cached = () => caches.open(CACHE).then(c => c.match(key));

  // 오디오 구간 재생(Range 요청): 받아 둔 게 있으면 그걸 잘라서 준다. 음성은 바뀔 일이 없고
  // (바뀌면 rev 가 갱신), 매번 네트워크를 타면 데이터만 쓴다.
  const range = req.headers.get('range');
  if (range) {
    const hit = await cached();
    return hit ? sliceRange(hit, range) : fetch(req);
  }

  const net = fetch(req);
  net.catch(() => {});      // 시간 초과로 사본을 쓴 뒤 늦게 실패해도 조용히
  try {
    return await Promise.race([
      net,
      new Promise((_, no) => setTimeout(() => no(new Error('timeout')), NET_TIMEOUT)),
    ]);
  } catch (err) {
    const hit = await cached();
    if (!hit) return net;   // 사본도 없으면 느린 네트워크라도 끝까지 기다린다
    return req.method === 'HEAD' ? new Response(null, { status: 200, headers: hit.headers }) : hit;
  }
}

// 사파리 오디오는 206(부분 응답)이 아니면 구간 이동을 못 한다. 통째 사본에서 요청한 범위만 잘라 준다.
async function sliceRange(res, range) {
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let start, end;
  if (!m[1] && m[2]) { start = Math.max(0, size - +m[2]); end = size - 1; }   // bytes=-500 (끝에서 500)
  else { start = +(m[1] || 0); end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
