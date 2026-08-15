import { SITE_VARIANT } from '@/config/variant';
import { buildVariantMeta } from '@/config/variant-meta';
import { RAW_APP_DOMAIN } from '@/config/domain';

const variantMetaMap = buildVariantMeta(RAW_APP_DOMAIN);
const variantMeta = variantMetaMap[SITE_VARIANT] ?? variantMetaMap.full;
const CANONICAL_URL = variantMeta.url;
const PUBLIC_ORIGIN = new URL(variantMeta.url).origin;
const DEFAULT_IMAGE = `${PUBLIC_ORIGIN}/favico/${SITE_VARIANT === 'full' ? '' : SITE_VARIANT + '/'}og-image.png`;

export function resetMetaTags(): void {
  document.title = variantMeta.title;

  setMetaTag('title', variantMeta.title);
  setMetaTag('description', variantMeta.description);
  setCanonicalLink(CANONICAL_URL);
  setMetaTag('og:title', variantMeta.title);
  setMetaTag('og:description', variantMeta.description);
  setMetaTag('og:url', CANONICAL_URL);
  setMetaTag('og:image', DEFAULT_IMAGE);
  setMetaTag('twitter:title', variantMeta.title);
  setMetaTag('twitter:description', variantMeta.description);
  setMetaTag('twitter:url', CANONICAL_URL);
  setMetaTag('twitter:image', DEFAULT_IMAGE);
}

function setMetaTag(property: string, content: string): void {
  const existing = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
  if (existing) existing.remove();

  const meta = document.createElement('meta');
  if (property.startsWith('og:')) {
    meta.setAttribute('property', property);
  } else {
    meta.setAttribute('name', property);
  }
  meta.setAttribute('content', content);
  document.head.appendChild(meta);
}

function setCanonicalLink(href: string): void {
  let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement;
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  link.setAttribute('href', href);
}
