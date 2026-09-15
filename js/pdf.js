/* ===========================================================
   作業報告書 — PDF生成（Phase 3）
   pdf-lib + fontkit で日本語フォントをサブセット埋め込み。
   レイアウト:
     1ページ目  : 表紙（「作業報告書」/ 発行日 / 注文番号・工事名・工事場所 / 自社情報）
     2ページ目〜: 写真2〜4枚/ページ（写真＋施工区分）
   公開API: window.KojiPDF.generate({ job, company, photos }) -> Uint8Array
   =========================================================== */

window.KojiPDF = (function () {
  "use strict";

  const { PDFDocument, rgb } = PDFLib;

  // A4 ポートレート（pt）
  const W = 595.28;
  const H = 841.89;
  const MARGIN = 40;

  const COLOR_TEXT = rgb(0.11, 0.11, 0.12);
  const COLOR_SUB = rgb(0.45, 0.45, 0.46);
  const COLOR_LINE = rgb(0.78, 0.78, 0.8);

  // 日本語フォント（TrueType/glyf）。
  // 注: pdf-lib(1.17.1)+fontkit のサブセット機能はグリフ欠落のバグがあるため、
  //     subset を使わず全埋め込み（embedFont の subset:false）で確実に埋め込む。
  const FONT_URL = "fonts/MPLUS1p-Regular.ttf";
  let fontBytesCache = null;

  async function getFontBytes() {
    if (fontBytesCache) return fontBytesCache;
    const res = await fetch(FONT_URL);
    if (!res.ok) throw new Error("フォントの読み込みに失敗しました");
    fontBytesCache = await res.arrayBuffer();
    return fontBytesCache;
  }

  /* ---------- 文字列を幅に合わせて折り返す（日本語=文字単位） ---------- */
  function wrapText(font, text, size, maxW) {
    const lines = [];
    let cur = "";
    for (const ch of String(text)) {
      if (ch === "\n") {
        lines.push(cur);
        cur = "";
        continue;
      }
      const test = cur + ch;
      if (font.widthOfTextAtSize(test, size) > maxW && cur) {
        lines.push(cur);
        cur = ch;
      } else {
        cur = test;
      }
    }
    lines.push(cur);
    return lines;
  }

  /* ---------- 写真を JPEG バイト列へ（HEIC/回転/サイズ最適化） ---------- */
  async function fileToJpegBytes(file, maxDim, quality) {
    maxDim = maxDim || 1600;
    quality = quality || 0.82;

    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      bmp = await createImageBitmap(file); // 古い実装向けフォールバック
    }

    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const cw = Math.max(1, Math.round(bmp.width * scale));
    const ch = Math.max(1, Math.round(bmp.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(bmp, 0, 0, cw, ch);
    if (bmp.close) bmp.close();

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    return new Uint8Array(await blob.arrayBuffer());
  }

  /* ---------- 表紙 ---------- */
  function drawCover(page, font, job, company) {
    // 発行日（右上）。書類を出した日＝PDFを作った日。
    const d = new Date();
    const issued =
      "発行日: " + d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
    const issuedSize = 11;
    const iw = font.widthOfTextAtSize(issued, issuedSize);
    page.drawText(issued, {
      x: W - MARGIN - iw,
      y: H - 70,
      size: issuedSize,
      font,
      color: COLOR_SUB,
    });

    // タイトル
    const title = "作業報告書";
    const titleSize = 30;
    const tw = font.widthOfTextAtSize(title, titleSize);
    page.drawText(title, {
      x: (W - tw) / 2,
      y: H - 130,
      size: titleSize,
      font,
      color: COLOR_TEXT,
    });

    // 情報テーブル（罫線付き）。工事場所は「顧客名＋工事場所」を2段表示。
    const rows = [
      { label: "注文番号", lines: [job.orderNo || ""] },
      { label: "工事名", lines: [job.name || ""] },
      { label: "工事場所", lines: [job.customer || "", job.place || ""] },
    ];
    const tableW = W - MARGIN * 2;
    const labelW = 110;
    const baseRowH = 44;
    const tallRowH = 64; // 2段表示の行は枠を高く
    const tableTop = H - 230;
    const tableLeft = MARGIN;
    const valSize = 13;
    const labelSize = 12;
    const maxValW = tableW - labelW - 24;

    let top = tableTop;
    rows.forEach((row) => {
      const multi = row.lines.length > 1;
      const rowH = multi ? tallRowH : baseRowH;
      const bottom = top - rowH;
      // 行の外枠
      page.drawRectangle({
        x: tableLeft,
        y: bottom,
        width: tableW,
        height: rowH,
        borderColor: COLOR_LINE,
        borderWidth: 1,
      });
      // ラベル列の区切り
      page.drawLine({
        start: { x: tableLeft + labelW, y: top },
        end: { x: tableLeft + labelW, y: bottom },
        thickness: 1,
        color: COLOR_LINE,
      });
      // ラベル（縦中央）
      page.drawText(row.label, {
        x: tableLeft + 12,
        y: bottom + (rowH - labelSize) / 2,
        size: labelSize,
        font,
        color: COLOR_SUB,
      });
      // 値（空行は除外。複数行は縦中央にまとめて配置。各行は幅に合わせて縮小）
      const shown = row.lines.filter((t) => t && t.length);
      const lineGap = 6;
      const n = shown.length;
      if (n > 0) {
        const blockH = n * valSize + (n - 1) * lineGap;
        let lineTopY = bottom + (rowH + blockH) / 2;
        shown.forEach((text) => {
          let vs = valSize;
          while (vs > 8 && font.widthOfTextAtSize(text, vs) > maxValW) vs -= 0.5;
          page.drawText(text, {
            x: tableLeft + labelW + 12,
            y: lineTopY - valSize,
            size: vs,
            font,
            color: COLOR_TEXT,
          });
          lineTopY -= valSize + lineGap;
        });
      }
      top = bottom;
    });

    // 自社情報（下部・中央寄せ）
    const infoLines = [];
    if (company.name) infoLines.push(company.name);
    const addr =
      (company.postal ? "〒" + company.postal + "  " : "") +
      (company.address || "");
    if (addr.trim()) infoLines.push(addr);
    const telfax =
      (company.tel ? "TEL " + company.tel : "") +
      (company.fax ? "　　FAX " + company.fax : "");
    if (telfax.trim()) infoLines.push(telfax);

    const infoSize = 12;
    let y = 150;
    infoLines.forEach((line, idx) => {
      const size = idx === 0 ? 14 : infoSize;
      const lw = font.widthOfTextAtSize(line, size);
      page.drawText(line, {
        x: (W - lw) / 2,
        y: y,
        size,
        font,
        color: idx === 0 ? COLOR_TEXT : COLOR_SUB,
      });
      y -= idx === 0 ? 24 : 20;
    });
  }

  // 画像枠＋画像（アスペクト比保持で枠内に収める）
  function drawImageBox(page, image, x, y, w, h) {
    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      borderColor: COLOR_LINE,
      borderWidth: 1,
    });
    if (image) {
      const scale = Math.min(w / image.width, h / image.height);
      const dw = image.width * scale;
      const dh = image.height * scale;
      page.drawImage(image, {
        x: x + (w - dw) / 2,
        y: y + (h - dh) / 2,
        width: dw,
        height: dh,
      });
    }
  }

  // ラベル＋値の1ブロックを描画。topYから下へ。ブロック下端yを返す。
  function drawBlock(page, font, label, value, x, topY, width, labelSize, valSize) {
    page.drawText(label, {
      x,
      y: topY - labelSize,
      size: labelSize,
      font,
      color: COLOR_SUB,
    });
    let yy = topY - labelSize - 3;
    wrapText(font, value || "", valSize, width).forEach((line) => {
      page.drawText(line, {
        x,
        y: yy - valSize,
        size: valSize,
        font,
        color: COLOR_TEXT,
      });
      yy -= valSize + 3;
    });
    return yy;
  }

  // 写真ごとの文言を描画する。出すのは施工区分だけ。
  // ※ 工事件名・工事場所は表紙にあるため、撮影日は不要のため、ここには出さない。
  function drawFields(page, font, x, topY, width, texts, labelSize, valSize) {
    return (
      drawBlock(page, font, "施工区分", texts.category, x, topY, width, labelSize, valSize) - 6
    );
  }

  /* ---------- 行レイアウト（2・3枚/ページ）: 左=写真、右=文言 ---------- */
  function drawPhotoSlot(page, font, image, texts, slotTop, slotH) {
    const pad = 10;
    const innerTop = slotTop - pad;
    const innerH = slotH - pad * 2;
    const imgBoxX = MARGIN;
    const imgBoxW = 290;
    const imgBoxY = innerTop - innerH;

    drawImageBox(page, image, imgBoxX, imgBoxY, imgBoxW, innerH);

    const textX = imgBoxX + imgBoxW + 18;
    const textW = W - MARGIN - textX;
    drawFields(page, font, textX, innerTop - 6, textW, texts, 10, 12);
  }

  /* ---------- グリッドレイアウト（4枚/ページ）: 上=写真、下=文言 ---------- */
  function drawPhotoCell(page, font, image, texts, cellLeft, cellTop, cellW, cellH) {
    // 施工区分が「選択＋自由入力」で2行になり得るため文言領域を1行分広めに確保
    const textH = 52;
    // 枠が高すぎると横長写真の上下に余白が増えるため、4:3が収まる高さを上限にする
    const imgBoxH = Math.min(cellH - textH, cellW * 0.78);
    const imgBoxY = cellTop - imgBoxH; // 枠の下端

    drawImageBox(page, image, cellLeft, imgBoxY, cellW, imgBoxH);

    // 写真の下に施工区分
    drawFields(page, font, cellLeft, imgBoxY - 6, cellW, texts, 9, 11);
  }

  /* ---------- 全幅レイアウト（2枚/ページ）: 上=写真(全幅)、下=文言 ---------- */
  function drawPhotoWide(page, font, image, texts, slotTop, slotH) {
    const pad = 10;
    const innerTop = slotTop - pad;
    const innerH = slotH - pad * 2;
    const x = MARGIN;
    const w = W - MARGIN * 2; // 枠は幅いっぱい
    const textH = 52; // 施工区分の1段ぶん
    const imgBoxH = innerH - textH;
    const imgBoxY = innerTop - imgBoxH;

    drawImageBox(page, image, x, imgBoxY, w, imgBoxH);
    drawFields(page, font, x, imgBoxY - 8, w, texts, 10, 12);
  }

  /* ---------- メイン ---------- */
  async function generate(data) {
    const job = data.job || {};
    const company = data.company || {};
    const photos = data.photos || [];
    const onProgress = data.onProgress || function () {};

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);

    onProgress("フォントを準備中…");
    const fontBytes = await getFontBytes();
    // subset:false で全グリフを埋め込む（サブセッタのグリフ欠落バグ回避）
    const font = await doc.embedFont(fontBytes, { subset: false });

    // 表紙
    const cover = doc.addPage([W, H]);
    drawCover(cover, font, job, company);

    // 写真ページ（2/3枚=行レイアウト, 4枚=2列2段グリッド）
    const perPage = [2, 3, 4].indexOf(data.perPage) >= 0 ? data.perPage : 3;
    const contentW = W - MARGIN * 2;
    const contentH = H - MARGIN * 2;
    const contentTop = H - MARGIN;

    // 4枚グリッドの寸法
    const gapX = 16;
    const gapY = 16;
    const cellW = (contentW - gapX) / 2;
    const cellH = (contentH - gapY) / 2;

    for (let i = 0; i < photos.length; i++) {
      onProgress("写真を処理中… " + (i + 1) + "/" + photos.length);
      const photo = photos[i];

      // ページ確保
      if (i % perPage === 0) {
        doc.addPage([W, H]);
      }
      const page = doc.getPages()[doc.getPageCount() - 1];

      // 画像を埋め込み（常にJPEG化）
      let image = null;
      try {
        const jpgBytes = await fileToJpegBytes(photo.file);
        image = await doc.embedJpg(jpgBytes);
      } catch (e) {
        console.error("[koji] 画像の埋め込み失敗:", e);
      }

      const texts = {
        // 工事件名・工事場所は表紙に載るため、写真ページには出さない
        // 施工区分は「選択した区分」と「自由入力」を別々の行で表示する
        category: [photo.category, photo.note].filter(Boolean).join("\n"),
      };
      const idx = i % perPage;

      if (perPage === 4) {
        const col = idx % 2;
        const row = Math.floor(idx / 2);
        const cellLeft = MARGIN + col * (cellW + gapX);
        const cellTop = contentTop - row * (cellH + gapY);
        drawPhotoCell(page, font, image, texts, cellLeft, cellTop, cellW, cellH);
      } else if (perPage === 2) {
        // 全幅: 上=写真(幅いっぱい)、下=2段の文言
        const slotH = contentH / 2;
        const slotTop = contentTop - idx * slotH;
        drawPhotoWide(page, font, image, texts, slotTop, slotH);
      } else {
        // 3枚: 左=写真、右=文言
        const slotH = contentH / perPage;
        const slotTop = contentTop - idx * slotH;
        drawPhotoSlot(page, font, image, texts, slotTop, slotH);
      }
    }

    onProgress("PDFを書き出し中…");
    return await doc.save();
  }

  return { generate };
})();
