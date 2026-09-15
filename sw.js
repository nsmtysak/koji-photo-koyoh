/* ===========================================================
   工事写真台帳 — Service Worker
   方針: ネットワーク優先（network-first）。
   - オンライン時は常に最新を取得 → 取得分をキャッシュへ更新。
   - オフライン時のみキャッシュから配信（最低限のオフライン対応）。
   ※ アプリ更新がすぐ反映されるよう、開発中は network-first にしている。
   ※ キャッシュを作り直したい時は CACHE_NAME のバージョンを上げる。
   =========================================================== */

const CACHE_NAME = "koji-photo-koyoh-v7";

/* GitHub Pages は Cache-Control: max-age=600 を返すため、ふつうに fetch すると
   最大10分ぶん古いファイルがブラウザのキャッシュから返る。HTMLだけ新しくJSが古い、
   といった食い違いが起きてアプリが起動しなくなるので、常にサーバーへ問い合わせる
   （no-cache = キャッシュがあっても更新の有無を確認する。変更が無ければ304で軽い）。 */
const NO_CACHE = { cache: "no-cache" };

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/pdf.js",
  "./js/lib/pdf-lib.min.js",
  "./js/lib/fontkit.umd.min.js",
  "./fonts/MPLUS1p-Regular.ttf",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

// インストール: App Shell を事前キャッシュ（オフライン初回用）
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(APP_SHELL.map((url) => new Request(url, NO_CACHE)))
      )
  );
  self.skipWaiting(); // 新SWを即時待機解除
});

// 有効化: 古いキャッシュを削除し、すぐ全クライアントを制御下に置く
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// 取得: ネットワーク優先、失敗時のみキャッシュ
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // GET 以外・別オリジンはそのまま通す
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request, NO_CACHE)
      .then((response) => {
        // 正常応答ならキャッシュを更新（次のオフライン用）
        if (response && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        // オフライン時: キャッシュ → 無ければ index.html（ナビゲーション用）
        caches.match(request).then((cached) => cached || caches.match("./index.html"))
      )
  );
});
