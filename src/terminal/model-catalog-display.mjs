import { c } from './ansi.mjs';

export const MODEL_CATEGORY_ORDER = [
  'text',
  'image_analysis',
  'image_generation',
  'image',
  'multimodal',
  'embedding',
  'audio',
  'video',
  'other',
];

export function modelCategory(model) {
  const category = String(model?.category || 'text').trim().toLowerCase();
  return category === 'chat' ? 'text' : (category || 'text');
}

export function isImageGenerationModel(model) {
  const text = `${model?.id || ''} ${model?.label || ''}`.toLowerCase();
  return (
    text.includes('image generation') ||
    text.includes('generate image') ||
    text.includes('gemini-3-pro-image') ||
    text.includes('nano banana')
  );
}

export function modelDisplayCategory(model) {
  const category = modelCategory(model);
  if (category === 'image') {
    return isImageGenerationModel(model) ? 'image_generation' : 'image_analysis';
  }
  return category;
}

export function normalizeCatalogCategory(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'chat') return 'text';
  if (raw === 'image-analysis' || raw === 'vision') return 'image_analysis';
  if (raw === 'image-generation' || raw === 'image-gen') return 'image_generation';
  return raw;
}

export function modelMatchesCatalogFilter(model, filter) {
  if (!filter) return true;
  if (filter === 'image') return modelCategory(model) === 'image';
  return modelDisplayCategory(model) === filter || modelCategory(model) === filter;
}

export function modelCategoryLabel(category, { plural = false } = {}) {
  const labels = {
    text: 'text',
    image: 'image',
    image_analysis: 'image analysis',
    image_generation: 'image generation',
    embedding: 'embedding',
    audio: 'audio',
    video: 'video',
    other: 'other',
    multimodal: 'multimodal',
  };
  const base = labels[String(category || '').trim().toLowerCase()] || 'other';
  return plural ? `${base} models` : base;
}

function categoryColor(category) {
  switch (String(category || '').trim().toLowerCase()) {
    case 'text':
      return c.brand;
    case 'image':
    case 'image_analysis':
      return c.magenta;
    case 'image_generation':
      return c.yellow;
    case 'multimodal':
      return c.cyanBold;
    case 'embedding':
      return c.green;
    case 'audio':
      return c.cyanRegular;
    case 'video':
      return c.red;
    default:
      return c.gray;
  }
}

export function formatCategoryBadge(category, { plural = false } = {}) {
  const normalized = String(category || 'text').trim().toLowerCase() || 'text';
  return categoryColor(normalized)(`[${modelCategoryLabel(normalized, { plural })}]`);
}

export function formatCategoryHeading(category, count = null) {
  const label = modelCategoryLabel(category, { plural: true });
  const countText = Number.isFinite(Number(count)) ? ` ${c.dim(`(${count})`)}` : '';
  return `${categoryColor(category)(c.bold(label))}${countText}`;
}

export function cacheProfileLabel(value) {
  if (!value) return '';
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed?.type === 'prefix_hash') return 'prefix cache';
  } catch {
    // Fall through to the generic cache hint.
  }
  return 'cache';
}
