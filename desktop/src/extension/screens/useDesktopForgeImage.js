// 制卡：单字段头像 / 背景重生成（桌面）。
//
// 手机在 CardForgeEditor 里有「AI 生成头像 / AI 生成背景」两个按钮（走视觉模型做
// 图片转卡）。桌面已有「图片制卡」（整卡），缺的是**只重画一张图**这一项——用的是
// 已经配好的生图服务，不需要视觉模型。
//
// 判定与调用全部复用共享层：
//   · imageGen/index.generateImage —— 端点/载荷/解析/错误映射；
//   · imageGen/providers.getImageProvider —— 当前服务商；
//   · storage/settings/imageGen.getImageGenSettings —— 服务商配置；
//   · storage/mediaProtection.markMediaWrite —— 落盘登记（避免被孤儿回收误删）。
// 桌面唯一与手机不同的是「图落到哪」：渲染层只能通过 easychat2-media:// 读
// documents/ 下的文件，所以统一写盘（与内联配图、生图页同一套）。
import { useCallback, useState } from 'react';

import { generateImage } from '../../../../src/imageGen/index.js';
import { getImageProvider } from '../../../../src/imageGen/providers.js';
import { getImageGenSettings } from '../../../../src/storage/settings/imageGen.js';
import { markMediaWrite } from '../../../../src/storage/mediaProtection.js';
import { documentDirectory } from '../../platform/fileSystem.js';
import { getBridge } from '../../platform/bridge.js';

const IMAGE_DIR = 'forge-images';

// 提示词：用草稿里已有的外观描述拼一句，用户额外要求接在后面。
// 不引入新的共享提示词模块——这里只是「把已有字段拼成一句」，不是模型协议。
export function buildForgeImagePrompt({ target, draft, hint }) {
  const source = draft && typeof draft === 'object' ? draft : {};
  const name = String(source.name || '').trim();
  const appearance = target === 'bg'
    ? String(source.scenario || '').trim()
    : String(source.description || '').trim();
  const parts = [];
  if (target === 'bg') {
    parts.push(name ? `${name} 的场景背景` : '角色卡背景图');
    if (appearance) parts.push(appearance.slice(0, 300));
    parts.push('无人物特写，氛围感强，适合作为竖版卡片背景');
  } else {
    parts.push(name ? `${name} 的头像` : '角色头像');
    if (appearance) parts.push(appearance.slice(0, 300));
    parts.push('单人肖像，正面，简洁背景，适合作为圆形头像');
  }
  const extra = String(hint || '').trim();
  if (extra) parts.push(extra.slice(0, 200));
  // 用换行连接而不是中文分号：提示词是发给模型的多行描述，换行更清晰，
  // 也避免在英文界面里混入中文标点（i18n lint 会拦）。
  return parts.filter(Boolean).join('\n');
}

export default function useDesktopForgeImage({ onApply }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const generate = useCallback(async ({ target, draft, hint }) => {
    if (busy) return null;
    setBusy(target);
    setError('');
    try {
      const settings = await getImageGenSettings();
      const provider = getImageProvider(settings && settings.activeProvider);
      if (!provider) throw new Error('image-provider-missing');
      const prompt = buildForgeImagePrompt({ target, draft, hint });
      const result = await generateImage({
        provider,
        prompt,
        size: target === 'bg' ? '1024x1536' : '1024x1024',
        config: settings && settings.providers ? settings.providers[provider.id] : undefined,
      });
      const base64 = String((result && result.base64) || '');
      if (!base64) throw new Error('image-empty');
      const ext = String((result && result.mime) || '').includes('png') ? 'png' : 'jpg';
      const filePath = `${documentDirectory}${IMAGE_DIR}/forge-${target}-${Date.now()}.${ext}`;
      await getBridge().fs.mkdir(`${documentDirectory}${IMAGE_DIR}`, true).catch(() => {});
      await getBridge().fs.write(filePath, base64, 'base64');
      // 登记媒体保护：否则孤儿回收会把这张刚生成的图当垃圾删掉。
      markMediaWrite(filePath);
      const field = target === 'bg' ? 'bgUri' : 'avatarUri';
      if (typeof onApply === 'function') onApply({ [field]: filePath });
      return filePath;
    } catch (caught) {
      setError(String((caught && caught.message) || caught || ''));
      return null;
    } finally {
      setBusy('');
    }
  }, [busy, onApply]);

  return { generate, busy, error };
}
