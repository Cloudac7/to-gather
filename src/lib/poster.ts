import QRCode from 'qrcode';
import type { AnswerDraft, AnswerFieldKey, RoomTemplate } from './types';
import { createEmptyDraft, EMPTY_ANSWER_IMAGES } from './types';

export interface PosterPerson {
  nickname: string;
  slot: 1 | 2;
  avatarUrl: string;
  answer: AnswerDraft;
  imageUrls: Record<AnswerFieldKey, string | null>;
  blank?: boolean;
}

export interface PosterInput {
  template: RoomTemplate;
  host: PosterPerson;
  guest: PosterPerson;
  shareUrl?: string;
  footerDescription?: string;
  qrCaption?: string;
}

export function buildSingleInvitePosterInput(
  template: RoomTemplate,
  host: PosterPerson,
  inviteUrl: string,
): PosterInput {
  return {
    template,
    host,
    guest: {
      nickname: '',
      slot: 2,
      avatarUrl: '',
      answer: createEmptyDraft(),
      imageUrls: { ...EMPTY_ANSWER_IMAGES },
      blank: true,
    },
    shareUrl: inviteUrl,
    footerDescription: '这一面已经写好，下一面等你来填。',
    qrCaption: '扫码加入房间填写',
  };
}

const WIDTH = 1600;
const HEIGHT = 1600;
const INK = '#11110f';
const PAPER = '#fffef9';
const BACKGROUND = '#f4f0e7';
const ACID = '#eaff54';
const BLUE = '#dfe6ff';

function chars(value: string, max: number) {
  const pieces = Array.from(value.trim());
  return pieces.length > max ? `${pieces.slice(0, max).join('')}…` : pieces.join('');
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  if (radius > 0) ctx.roundRect(x, y, width, height, radius);
  else ctx.rect(x, y, width, height);
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  ctx.drawImage(image, x - (drawnWidth - width) / 2, y - (drawnHeight - height) / 2, drawnWidth, drawnHeight);
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  ctx.drawImage(image, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}

async function loadBitmap(url: string) {
  if (url.startsWith('data:')) {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('二维码图片加载失败'));
      image.src = url;
    });
    return createImageBitmap(image);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error('图片加载失败');
  return createImageBitmap(await response.blob());
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const source = Array.from(text || '—');
  const lines: string[] = [];
  let current = '';
  for (const character of source) {
    const candidate = current + character;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = character;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  const consumed = lines.join('').length;
  if (consumed < source.length && lines.length) {
    let last = lines.at(-1) ?? '';
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

function drawTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxLines: number,
  lineHeight: number,
) {
  const lines = wrapText(ctx, text, maxWidth, maxLines);
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
}

interface LoadedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface AnswerCellLayout {
  padding: number;
  textTop: number;
  textFontSize: number;
  textLineHeight: number;
  maxTextLines: number;
  imageFit: 'cover' | 'contain';
  imageBox: { left: number; top: number; width: number; height: number } | null;
}

export function calculateAnswerCellLayout(
  width: number,
  height: number,
  hasImage: boolean,
  hasText: boolean,
  compact = false,
): AnswerCellLayout {
  const padding = compact ? 12 : 16;
  if (hasImage) {
    const imageTop = compact ? 38 : 44;
    const textFontSize = compact ? 17 : 20;
    const textLineHeight = compact ? 23 : 27;
    const maxTextLines = hasText ? (height >= 220 ? 2 : 1) : 0;
    const bottomPadding = compact ? 10 : 14;
    const imageTextGap = hasText ? (compact ? 8 : 10) : 0;
    const textHeight = maxTextLines * textLineHeight;
    const availableImageHeight = height - imageTop - bottomPadding - imageTextGap - textHeight;
    const maxImageHeight = hasText
      ? height >= 220
        ? compact
          ? 112
          : 132
        : Math.max(42, height - imageTop - bottomPadding)
      : availableImageHeight;
    const imageHeight = Math.max(34, Math.min(maxImageHeight, availableImageHeight));
    const maxImageWidth = hasText ? (compact ? 140 : width >= 400 ? 220 : 168) : width - padding * 2;
    const imageWidth = Math.min(width - padding * 2, maxImageWidth);
    return {
      padding,
      textTop: imageTop + imageHeight + imageTextGap,
      textFontSize,
      textLineHeight,
      maxTextLines,
      imageFit: 'contain',
      imageBox: {
        left: (width - imageWidth) / 2,
        top: imageTop,
        width: imageWidth,
        height: imageHeight,
      },
    };
  }
  const textTop = compact ? 50 : 58;
  const textLineHeight = compact ? 27 : height >= 220 ? 31 : 30;
  const bottomPadding = compact ? 12 : 16;
  return {
    padding,
    textTop,
    textFontSize: compact ? 19 : height >= 220 ? 24 : 22,
    textLineHeight,
    maxTextLines: Math.max(1, Math.floor((height - textTop - bottomPadding) / textLineHeight)),
    imageFit: 'contain',
    imageBox: null,
  };
}

function drawAnswerCell(
  ctx: CanvasRenderingContext2D,
  person: PosterPerson,
  template: RoomTemplate,
  key: AnswerFieldKey,
  images: Map<string, LoadedImage>,
  x: number,
  y: number,
  width: number,
  height: number,
  compact = false,
) {
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, width, height);
  ctx.beginPath();
  ctx.rect(x + 3, y + 3, width - 6, height - 6);
  ctx.clip();

  const padding = compact ? 12 : 16;
  ctx.fillStyle = '#706d65';
  ctx.font = `800 ${compact ? 15 : 18}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(chars(template.fieldLabels[key], compact ? 9 : 12), x + padding, y + padding);

  const imageUrl = person.imageUrls[key];
  const loaded = imageUrl ? images.get(imageUrl) : undefined;
  const answer = person.answer[key] || '';
  const layout = calculateAnswerCellLayout(width, height, Boolean(loaded), Boolean(answer), compact);
  if (loaded) {
    const imageBox = layout.imageBox!;
    const drawImage = layout.imageFit === 'contain' ? drawContain : drawCover;
    drawImage(ctx, loaded.bitmap, loaded.width, loaded.height, x + imageBox.left, y + imageBox.top, imageBox.width, imageBox.height);
    if (answer) {
      ctx.fillStyle = INK;
      ctx.font = `800 ${layout.textFontSize}px 'Songti SC', 'STSong', serif`;
      drawTextLines(
        ctx,
        answer,
        x + padding,
        y + layout.textTop,
        width - padding * 2,
        layout.maxTextLines,
        layout.textLineHeight,
      );
    }
  } else if (!person.blank) {
    ctx.fillStyle = INK;
    ctx.font = `800 ${layout.textFontSize}px 'Songti SC', 'STSong', serif`;
    drawTextLines(
      ctx,
      answer || '—',
      x + padding,
      y + layout.textTop,
      width - padding * 2,
      layout.maxTextLines,
      layout.textLineHeight,
    );
  }
  ctx.restore();
}

function drawPortrait(
  ctx: CanvasRenderingContext2D,
  person: PosterPerson,
  loaded: LoadedImage | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
  tint: string,
) {
  ctx.save();
  ctx.fillStyle = tint;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, width, height);
  ctx.beginPath();
  ctx.rect(x + 3, y + 3, width - 6, height - 6);
  ctx.clip();
  if (loaded) drawCover(ctx, loaded.bitmap, loaded.width, loaded.height, x, y, width, height);
  if (!person.blank) {
    ctx.fillStyle = 'rgba(17,17,15,.82)';
    ctx.fillRect(x, y + height - 74, width, 74);
    ctx.fillStyle = PAPER;
    ctx.font = "900 32px 'Songti SC', 'STSong', serif";
    ctx.textBaseline = 'middle';
    ctx.fillText(chars(person.nickname, 12), x + 22, y + height - 38);
  }
  ctx.restore();
}

async function loadPosterImages(input: PosterInput) {
  const urls = new Set<string>();
  for (const person of [input.host, input.guest]) {
    if (person.avatarUrl) urls.add(person.avatarUrl);
    for (const url of Object.values(person.imageUrls)) if (url) urls.add(url);
  }
  const entries = await Promise.all(
    [...urls].map(async (url) => {
      try {
        const bitmap = await loadBitmap(url);
        return [url, { bitmap, width: bitmap.width, height: bitmap.height }] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)));
}

export async function generatePoster(input: PosterInput): Promise<Blob> {
  await document.fonts?.ready;
  const images = await loadPosterImages(input);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器无法生成图片');

  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = "900 62px 'Noto Serif SC', 'Songti SC', 'STSong', serif";
  ctx.fillText(chars(input.template.title, 24), WIDTH / 2, 38);
  ctx.font = '700 23px system-ui, sans-serif';
  ctx.fillText(chars(input.template.subtitle, 40), WIDTH / 2, 112);
  ctx.textAlign = 'left';

  // The reference card uses one strict module: six equal columns across the
  // pair, with each portrait occupying a 2 × 2 square. Keeping every answer
  // cell on that module prevents text or uploaded images from warping the grid.
  const left = 50;
  const cellSize = 250;
  const half = cellSize * 3;
  const topY = 150;
  const topHeight = cellSize;
  const middleY = topY + topHeight;
  const middleHeight = cellSize * 2;
  const bottomY = middleY + middleHeight;
  const bottomHeight = cellSize;
  const messageY = bottomY + bottomHeight;
  const messageHeight = 150;
  const cellWidth = cellSize;
  const sideWidth = cellSize;

  const topKeys: AnswerFieldKey[] = ['favoriteAnimal', 'favoriteColor', 'favoritePerson'];
  const sideKeys: AnswerFieldKey[] = ['favoriteSong', 'mbti'];
  const bottomKeys: AnswerFieldKey[] = ['curiousAbout', 'recentProduct', 'dreamActivity'];

  for (const [personIndex, person] of [input.host, input.guest].entries()) {
    const baseX = left + personIndex * half;
    const orderedTopKeys = personIndex === 0 ? topKeys : [...topKeys].reverse();
    orderedTopKeys.forEach((key, index) => {
      drawAnswerCell(ctx, person, input.template, key, images, baseX + index * cellWidth, topY, cellWidth, topHeight);
    });
    const sideX = personIndex === 0 ? baseX : baseX + half - sideWidth;
    sideKeys.forEach((key, index) => {
      drawAnswerCell(
        ctx,
        person,
        input.template,
        key,
        images,
        sideX,
        middleY + index * (middleHeight / 2),
        sideWidth,
        middleHeight / 2,
        false,
      );
    });
    const portraitX = personIndex === 0 ? baseX + sideWidth : baseX;
    drawPortrait(
      ctx,
      person,
      images.get(person.avatarUrl),
      portraitX,
      middleY,
      half - sideWidth,
      middleHeight,
      person.slot === 1 ? ACID : BLUE,
    );
    const orderedBottomKeys = personIndex === 0 ? bottomKeys : [...bottomKeys].reverse();
    orderedBottomKeys.forEach((key, index) => {
      drawAnswerCell(ctx, person, input.template, key, images, baseX + index * cellWidth, bottomY, cellWidth, bottomHeight);
    });
    drawAnswerCell(
      ctx,
      person,
      input.template,
      'message',
      images,
      baseX,
      messageY,
      half,
      messageHeight,
    );
  }

  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.strokeRect(left, topY, half * 2, messageY + messageHeight - topY);
  ctx.beginPath();
  ctx.moveTo(WIDTH / 2, topY);
  ctx.lineTo(WIDTH / 2, messageY + messageHeight);
  ctx.stroke();

  const footerY = 1318;
  ctx.fillStyle = INK;
  roundedRect(ctx, 70, footerY + 30, 92, 92, 0);
  ctx.fill();
  ctx.fillStyle = PAPER;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = "900 52px 'Songti SC', 'STSong', serif";
  ctx.fillText('两', 116, footerY + 76);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = INK;
  ctx.font = "900 44px 'Songti SC', 'STSong', serif";
  ctx.fillText('一起揭晓', 190, footerY + 32);
  ctx.font = '700 22px system-ui, sans-serif';
  drawTextLines(
    ctx,
    input.footerDescription ?? '把喜欢、期待和想说的话，做成只属于你们的双人卡片。',
    190,
    footerY + 92,
    850,
    2,
    34,
  );
  ctx.font = '800 17px system-ui, sans-serif';
  ctx.fillStyle = '#706d65';
  ctx.fillText('TO-GATHER · 30 DAYS', 190, footerY + 176);

  const qrX = 1300;
  const qrY = footerY + 8;
  const qrSize = 200;
  ctx.fillStyle = PAPER;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.fillRect(qrX, qrY, qrSize, qrSize);
  ctx.strokeRect(qrX, qrY, qrSize, qrSize);
  if (input.shareUrl) {
    const qrDataUrl = await QRCode.toDataURL(input.shareUrl, {
      width: 600,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: INK, light: PAPER },
    });
    const qrBitmap = await loadBitmap(qrDataUrl);
    ctx.drawImage(qrBitmap, qrX + 14, qrY + 14, qrSize - 28, qrSize - 28);
    qrBitmap.close();
  } else {
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(qrX + 18, qrY + 18, qrSize - 36, qrSize - 36);
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 20px system-ui, sans-serif';
    ctx.fillText('确认公开后', qrX + qrSize / 2, qrY + 82);
    ctx.fillText('生成二维码', qrX + qrSize / 2, qrY + 112);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = INK;
  ctx.font = '800 16px system-ui, sans-serif';
  ctx.fillText(input.qrCaption ?? '扫码查看完整结果', qrX + qrSize / 2, qrY + qrSize + 12);

  for (const image of images.values()) image.bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('海报生成失败'))), 'image/png');
  });
}
