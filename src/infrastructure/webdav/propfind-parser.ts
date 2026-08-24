import type { FileMetadata } from '../../domain/ports.js';

/**
 * A deliberately small PROPFIND response parser.
 *
 * WebDAV multistatus bodies are XML, but the subset we need is fixed and
 * shallow: per `<response>`, an href and four scalar properties. Pulling in a
 * full XML parser would add a dependency — and an attack surface, since this
 * input arrives over the network — for no capability we use.
 *
 * The one real hazard is namespace prefixes: `d:`, `D:`, and unprefixed all
 * appear across Nextcloud, ownCloud and Apache mod_dav, so every tag is matched
 * prefix-insensitively rather than against whichever prefix one server happens
 * to emit.
 */

const RESPONSE_BLOCK = /<[a-z0-9]*:?response[\s>][\s\S]*?<\/[a-z0-9]*:?response>/gi;

const tagContent = (xml: string, tag: string): string | null => {
  const pattern = new RegExp(
    `<[a-z0-9]*:?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</[a-z0-9]*:?${tag}>`,
    'i',
  );
  return pattern.exec(xml)?.[1]?.trim() ?? null;
};

const hasTag = (xml: string, tag: string): boolean =>
  new RegExp(`<[a-z0-9]*:?${tag}(?:\\s[^>]*)?\\s*/?>`, 'i').test(xml);

const decodeXmlEntities = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    // Ampersand last, so a literal `&amp;lt;` does not become `<`.
    .replace(/&amp;/g, '&');

/** RFC 7232 strong entity-tag. Weak validators cannot drive `If-Match`. */
const STRONG_ETAG = /^"[\x21\x23-\x7E\x80-\xFF]*"$/;

const normaliseEtag = (raw: string | null): string | null => {
  if (raw === null) {
    return null;
  }
  const value = decodeXmlEntities(raw).trim();
  return STRONG_ETAG.test(value) ? value : null;
};

/** Parses a multistatus body into one entry per `<response>`. */
export const parsePropfind = (xml: string): FileMetadata[] => {
  const results: FileMetadata[] = [];

  for (const block of xml.match(RESPONSE_BLOCK) ?? []) {
    const href = tagContent(block, 'href');
    if (href === null) {
      continue;
    }

    const decodedHref = decodeXmlEntities(href);
    const isDirectory = hasTag(block, 'collection');
    const lastModifiedRaw = tagContent(block, 'getlastmodified');
    const lastModified = lastModifiedRaw === null ? null : parseHttpDate(lastModifiedRaw);

    // Nextcloud emits both `<d:getetag>` and `<oc:getetag>`; the owncloud-
    // namespaced one is the canonical validator, so it wins when both parse.
    const ocEtag = normaliseEtag(matchNamespacedEtag(block, 'oc'));
    const davEtag = normaliseEtag(tagContent(block, 'getetag'));

    results.push({
      name: basename(decodedHref),
      path: absolutePath(decodedHref),
      size: Number(tagContent(block, 'getcontentlength') ?? 0),
      lastModified,
      rev: ocEtag ?? davEtag,
      isDirectory,
    });
  }

  return results;
};

const matchNamespacedEtag = (xml: string, prefix: string): string | null =>
  new RegExp(`<${prefix}:getetag(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}:getetag>`, 'i')
    .exec(xml)?.[1]
    ?.trim() ?? null;

const parseHttpDate = (value: string): Date | null => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const basename = (href: string): string => {
  const path = absolutePath(href).replace(/\/+$/, '');
  const lastSlash = path.lastIndexOf('/');
  return decodeURIComponent(lastSlash === -1 ? path : path.slice(lastSlash + 1));
};

/** Strips the origin from an href, which servers may return absolute or not. */
const absolutePath = (href: string): string => {
  try {
    return new URL(href, 'http://placeholder.invalid').pathname;
  } catch {
    /* c8 ignore next -- URL only throws on inputs the href regex cannot yield. */
    return href;
  }
};
