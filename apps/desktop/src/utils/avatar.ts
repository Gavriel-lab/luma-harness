export function isAvatarDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 300000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export async function importLocalAvatar(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(file.type)) throw new Error('请选择 PNG、JPG、WebP、GIF 或 AVIF 图片。');
  if (file.size > 10 * 1024 * 1024) throw new Error('图片超过 10 MB，请换一张小一点的。');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('这张图片没有读成功，请换一张试试。'); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 20000 || bitmap.height > 20000) throw new Error('图片尺寸太大或无效，请换一张。');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('暂时无法处理图片，请重新打开设置再试。');
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    const data = canvas.toDataURL('image/webp', 0.9);
    if (!isAvatarDataUrl(data)) throw new Error('图片处理后仍然过大，请换一张简单一点的图片。');
    return data;
  } finally { bitmap.close(); }
}
