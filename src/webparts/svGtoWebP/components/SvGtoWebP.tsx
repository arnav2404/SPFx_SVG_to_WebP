import * as React from "react";
import styles from "./SvGtoWebP.module.scss";
import {
  PrimaryButton,
  DefaultButton,
  Dropdown,
  IDropdownOption,
  MessageBar,
  MessageBarType,
  ProgressIndicator,
  Text,
  Stack,
  Spinner,
  SpinnerSize,
  Icon
} from "@fluentui/react";


const SVG_WEBP_DEBUG_BUILD = "2026-10-05-v4-data-uri";
const SVG_WEBP_DEBUG_PREFIX = "[SVG→WebP DEBUG]";

function debugLog(step: string, data?: unknown): void {
  if (typeof console === "undefined") return;
  if (typeof data === "undefined") console.log(`${SVG_WEBP_DEBUG_PREFIX} ${step}`);
  else console.log(`${SVG_WEBP_DEBUG_PREFIX} ${step}`, data);
}

function debugWarn(step: string, data?: unknown): void {
  if (typeof console === "undefined") return;
  if (typeof data === "undefined") console.warn(`${SVG_WEBP_DEBUG_PREFIX} ${step}`);
  else console.warn(`${SVG_WEBP_DEBUG_PREFIX} ${step}`, data);
}

function debugError(step: string, data?: unknown): void {
  if (typeof console === "undefined") return;
  if (typeof data === "undefined") console.error(`${SVG_WEBP_DEBUG_PREFIX} ${step}`);
  else console.error(`${SVG_WEBP_DEBUG_PREFIX} ${step}`, data);
}

function debugGroup(label: string): void {
  if (typeof console === "undefined") return;
  if (console.groupCollapsed) console.groupCollapsed(`${SVG_WEBP_DEBUG_PREFIX} ${label}`);
}

function debugGroupEnd(): void {
  if (typeof console === "undefined") return;
  if (console.groupEnd) console.groupEnd();
}

function shortenDebugValue(value: string, max: number = 260): string {
  if (value.length <= max) return value;
  return value.substring(0, max) + `… (${value.length} chars)`;
}

function isPotentiallyExternalValue(value: string): boolean {
  return /(?:https?:\/\/|^\/\/|blob:|file:|ftp:|@import|url\()/i.test(value.trim());
}

function cssContainsExternalUrl(value: string): boolean {
  if (/@import/i.test(value)) return true;
  const re = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const url = (match[2] || "").trim();
    if (url && !isInlineResourceUrl(url)) return true;
  }
  return false;
}

function auditSvgDocument(doc: Document, label: string): void {
  debugGroup(`RESOURCE AUDIT — ${label}`);
  try {
    const selectors = [
      "image", "feImage", "use", "foreignObject", "style", "link", "img", "source",
      "video", "audio", "filter", "mask", "pattern", "clipPath", "font-face-uri"
    ];
    const counts: { [key: string]: number } = {};
    for (let i = 0; i < selectors.length; i++) {
      counts[selectors[i]] = doc.querySelectorAll(selectors[i]).length;
    }
    debugLog("element counts", counts);

    const refs: Array<{ element: string; attribute: string; value: string; external: boolean }> = [];
    const all = doc.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i] as Element;
      for (let a = 0; a < el.attributes.length; a++) {
        const attr = el.attributes[a];
        const name = attr.name.toLowerCase();
        const value = attr.value || "";
        const interesting =
          name === "href" || name === "xlink:href" || name === "src" || name === "srcset" ||
          name === "poster" || name === "data" || name === "style" || /url\(/i.test(value) ||
          isPotentiallyExternalValue(value);
        if (interesting) {
          refs.push({
            element: el.tagName,
            attribute: attr.name,
            value: shortenDebugValue(value),
            external: isPotentiallyExternalValue(value) && !isInlineResourceUrl(value)
          });
        }
      }
    }

    if (refs.length > 0) {
      debugLog(`resource-like attributes (${refs.length})`, refs);
    } else {
      debugLog("resource-like attributes", "none");
    }

    const styleNodes = doc.getElementsByTagName("style");
    for (let i = 0; i < styleNodes.length; i++) {
      const css = styleNodes[i].textContent || "";
      if (isPotentiallyExternalValue(css)) {
        debugWarn(`style[${i}] still contains URL/import text`, shortenDebugValue(css, 1200));
      }
    }
  } catch (err: unknown) {
    debugWarn("resource audit itself failed", getErrorMessage(err));
  } finally {
    debugGroupEnd();
  }
}

function auditSerializedSvg(svgText: string, label: string): void {
  debugGroup(`SERIALIZED SVG AUDIT — ${label}`);
  try {
    debugLog("serialized length", svgText.length);
    const suspicious = svgText.match(/(?:https?:\/\/|blob:|file:|ftp:|@import|url\()[^<>{}\s"']*/gi);
    if (suspicious && suspicious.length) {
      const samples: string[] = [];
      for (let i = 0; i < suspicious.length && i < 40; i++) samples.push(shortenDebugValue(suspicious[i], 400));
      debugWarn(`raw suspicious URL tokens (${suspicious.length})`, samples);
    } else {
      debugLog("raw suspicious URL tokens", "none");
    }
  } catch (err: unknown) {
    debugWarn("serialized audit failed", getErrorMessage(err));
  } finally {
    debugGroupEnd();
  }
}

type ConvertItem = {
  file: File;
  name: string;
  svgText: string;
  widthPx: number;
  heightPx: number;
  status: "queued" | "converting" | "done" | "error";
  error?: string;
  webpBlob?: Blob;
  webpUrl?: string;
};

function parseLengthToPx(v?: string): number | undefined {
  if (!v) return undefined;
  const raw = v.trim().toLowerCase();

  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);

  const px = raw.match(/^(\d+(\.\d+)?)px$/);
  if (px) return Number(px[1]);

  const pt = raw.match(/^(\d+(\.\d+)?)pt$/);
  if (pt) return Number(pt[1]) * (96 / 72);

  const inch = raw.match(/^(\d+(\.\d+)?)in$/);
  if (inch) return Number(inch[1]) * 96;

  const cm = raw.match(/^(\d+(\.\d+)?)cm$/);
  if (cm) return Number(cm[1]) * (96 / 2.54);

  const mm = raw.match(/^(\d+(\.\d+)?)mm$/);
  if (mm) return Number(mm[1]) * (96 / 25.4);

  return undefined;
}

function getSvgAttr(svgText: string, attr: string): string | undefined {
  const re = new RegExp(attr + "\\s*=\\s*[\"']([^\"']+)[\"']", "i");
  const m = re.exec(svgText);
  return m && m[1] ? m[1] : undefined;
}

function getSvgDimensions(svgText: string): { widthPx: number; heightPx: number } {
  const fallback = { widthPx: 512, heightPx: 512 };

  try {
    const widthAttr = getSvgAttr(svgText, "width");
    const heightAttr = getSvgAttr(svgText, "height");
    const viewBox = getSvgAttr(svgText, "viewBox") || getSvgAttr(svgText, "viewbox");

    const wParsed = parseLengthToPx(widthAttr);
    const hParsed = parseLengthToPx(heightAttr);

    if (wParsed && hParsed && wParsed > 0 && hParsed > 0) {
      return { widthPx: Math.round(wParsed), heightPx: Math.round(hParsed) };
    }

    if (viewBox) {
      const parts = viewBox.trim().split(/[\s,]+/).map((x) => Number(x));
      if (parts.length === 4) {
        const vbW = parts[2];
        const vbH = parts[3];
        if (vbW > 0 && vbH > 0) {
          return { widthPx: Math.round(vbW), heightPx: Math.round(vbH) };
        }
      }
    }
  } catch {
    // ignore
  }

  return fallback;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read an SVG resource"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Chromium can mark a canvas as tainted when an SVG containing <foreignObject>
 * is loaded through a blob: URL and then drawn with drawImage(), even when the
 * SVG has no true cross-origin resource. Loading the exact same SVG through a
 * data: URL avoids that blob/foreignObject origin path.
 */
async function svgTextToDataUrl(svgText: string): Promise<string> {
  const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  return await blobToDataUrl(blob);
}

function isInlineResourceUrl(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.length === 0 || v.indexOf("data:") === 0 || v.indexOf("#") === 0;
}

function splitUrlFragment(value: string): { url: string; fragment: string } {
  const hashAt = value.indexOf("#");
  if (hashAt < 0) return { url: value, fragment: "" };
  return { url: value.substring(0, hashAt), fragment: value.substring(hashAt) };
}

function makeAbsoluteResourceUrl(value: string, baseUrl?: string): string {
  const raw = value.trim();
  if (!raw) return raw;

  try {
    return new URL(raw, baseUrl || window.location.href).toString();
  } catch {
    return raw;
  }
}

async function fetchResourceBlob(resourceUrl: string, baseUrl?: string): Promise<Blob> {
  const absoluteUrl = makeAbsoluteResourceUrl(resourceUrl, baseUrl);
  debugLog("fetch resource → start", { resourceUrl, absoluteUrl, baseUrl: baseUrl || null });

  try {
    // credentials:'include' is important for same-tenant SharePoint resources.
    // For public cross-origin resources the browser will still require CORS.
    const response = await fetch(absoluteUrl, { credentials: "include" });
    debugLog("fetch resource → response", {
      url: absoluteUrl,
      ok: response.ok,
      status: response.status,
      type: response.type,
      contentType: response.headers.get("content-type")
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    debugLog("fetch resource → blob", { url: absoluteUrl, type: blob.type, size: blob.size });
    return blob;
  } catch (err: unknown) {
    debugError("fetch resource → FAILED", { url: absoluteUrl, error: getErrorMessage(err) });
    throw new Error(
      `The SVG uses a linked resource that cannot be embedded: ${resourceUrl}. ` +
      `The resource must be readable by the browser (CORS/authentication). (${getErrorMessage(err)})`
    );
  }
}

async function fetchResourceAsDataUrl(resourceUrl: string, baseUrl?: string): Promise<string> {
  const blob = await fetchResourceBlob(resourceUrl, baseUrl);
  return await blobToDataUrl(blob);
}

async function fetchResourceAsText(resourceUrl: string, baseUrl?: string): Promise<{ text: string; absoluteUrl: string }> {
  const absoluteUrl = makeAbsoluteResourceUrl(resourceUrl, baseUrl);
  try {
    const response = await fetch(absoluteUrl, { credentials: "include" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { text: await response.text(), absoluteUrl };
  } catch (err: unknown) {
    throw new Error(
      `The SVG uses a linked stylesheet/resource that cannot be embedded: ${resourceUrl}. ` +
      `(${getErrorMessage(err)})`
    );
  }
}

/**
 * Rewrites every CSS url(...) to a data URL. A base URL is accepted because URLs
 * inside an imported stylesheet are relative to the stylesheet, not the SharePoint page.
 */
async function inlineCssUrls(cssText: string, baseUrl?: string): Promise<string> {
  const matches: Array<{ raw: string; url: string }> = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(cssText)) !== null) {
    const resourceUrl = (match[2] || "").trim();
    if (!isInlineResourceUrl(resourceUrl)) {
      matches.push({ raw: match[0], url: resourceUrl });
    }
  }

  let result = cssText;
  for (let i = 0; i < matches.length; i++) {
    const item = matches[i];
    const dataUrl = await fetchResourceAsDataUrl(item.url, baseUrl);
    result = result.split(item.raw).join(`url("${dataUrl}")`);
  }

  return result;
}

/** Inline @import rules, then inline url(...) resources inside the imported CSS. */
async function inlineCssImports(cssText: string, baseUrl?: string): Promise<string> {
  const importRe = /@import\s+(?:url\(\s*)?["']?([^"'\)\s;]+)["']?\s*\)?\s*;/gi;
  const imports: Array<{ raw: string; url: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = importRe.exec(cssText)) !== null) {
    const resourceUrl = (match[1] || "").trim();
    if (resourceUrl && !isInlineResourceUrl(resourceUrl)) {
      imports.push({ raw: match[0], url: resourceUrl });
    }
  }

  let result = cssText;
  for (let i = 0; i < imports.length; i++) {
    const item = imports[i];
    const loaded = await fetchResourceAsText(item.url, baseUrl);
    let importedCss = await inlineCssImports(loaded.text, loaded.absoluteUrl);
    importedCss = await inlineCssUrls(importedCss, loaded.absoluteUrl);
    result = result.split(item.raw).join(importedCss);
  }

  return result;
}

async function inlineExternalStylesheets(doc: Document): Promise<void> {
  const links = doc.querySelectorAll("link[rel='stylesheet'][href], link[rel='StyleSheet'][href]");
  const replacements: Array<{ link: Element; css: string }> = [];

  for (let i = 0; i < links.length; i++) {
    const link = links[i] as Element;
    const href = link.getAttribute("href") || "";
    if (!href || isInlineResourceUrl(href)) continue;

    const loaded = await fetchResourceAsText(href);
    let css = await inlineCssImports(loaded.text, loaded.absoluteUrl);
    css = await inlineCssUrls(css, loaded.absoluteUrl);
    replacements.push({ link, css });
  }

  for (let i = 0; i < replacements.length; i++) {
    const item = replacements[i];
    const style = doc.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = item.css;
    const parent = item.link.parentNode;
    if (parent) parent.replaceChild(style, item.link);
  }
}

async function inlineHrefAttribute(el: Element, attrName: string, namespace?: string): Promise<void> {
  const raw = namespace ? el.getAttributeNS(namespace, "href") : el.getAttribute(attrName);
  if (!raw || isInlineResourceUrl(raw)) return;

  const parts = splitUrlFragment(raw);
  if (!parts.url) return;

  debugLog("inline href → start", { element: el.tagName, attribute: attrName, value: shortenDebugValue(raw) });
  const dataUrl = await fetchResourceAsDataUrl(parts.url);
  const rewritten = dataUrl + parts.fragment;

  if (namespace) el.setAttributeNS(namespace, attrName, rewritten);
  else el.setAttribute(attrName, rewritten);
  debugLog("inline href → done", { element: el.tagName, attribute: attrName, dataUrlLength: dataUrl.length, fragment: parts.fragment });
}

async function inlineSrcsetAttribute(el: Element, attrName: string = "srcset"): Promise<void> {
  const raw = el.getAttribute(attrName);
  if (!raw) return;

  // This is intentionally conservative. It supports the normal `url 1x, url 2x` /
  // `url 400w` forms used by <img>/<source>. Data URLs are preserved.
  const candidates = raw.split(",");
  const rewritten: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i].trim();
    if (!candidate) continue;

    const parts = candidate.split(/\s+/);
    const url = parts.shift() || "";
    const descriptor = parts.join(" ");
    if (!url || isInlineResourceUrl(url)) {
      rewritten.push(candidate);
      continue;
    }

    debugLog("inline srcset → start", { element: el.tagName, url: shortenDebugValue(url), descriptor });
    const dataUrl = await fetchResourceAsDataUrl(url);
    rewritten.push(dataUrl + (descriptor ? ` ${descriptor}` : ""));
    debugLog("inline srcset → done", { element: el.tagName, dataUrlLength: dataUrl.length, descriptor });
  }

  if (rewritten.length > 0) el.setAttribute(attrName, rewritten.join(", "));
}

function removeUnsafeDynamicContent(doc: Document): void {
  // Scripts can fetch resources after our sanitisation and taint the canvas.
  const dynamicNodes = doc.querySelectorAll("script, iframe, object, embed");
  for (let i = dynamicNodes.length - 1; i >= 0; i--) {
    const n = dynamicNodes[i];
    if (n.parentNode) n.parentNode.removeChild(n);
  }

  // Strip inline event handlers such as onload=... for the same reason.
  const all = doc.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as Element;
    const attrs = el.attributes;
    const toRemove: string[] = [];
    for (let a = 0; a < attrs.length; a++) {
      const name = attrs[a].name;
      if (/^on/i.test(name)) toRemove.push(name);
    }
    for (let a = 0; a < toRemove.length; a++) el.removeAttribute(toRemove[a]);
  }
}

/**
 * Canvas export is blocked when ANY resource used by the SVG is cross-origin.
 * This version handles SVG <image>, <feImage>, external <use> sprites, HTML <img>
 * inside foreignObject, CSS url(...), @font-face, @import and linked stylesheets.
 */
async function prepareSvgForCanvas(svgText: string): Promise<string> {
  debugGroup("prepareSvgForCanvas");
  debugLog("build marker", SVG_WEBP_DEBUG_BUILD);
  debugLog("original SVG", { length: svgText.length, first500: shortenDebugValue(svgText, 500) });

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");

  try {
    if (doc.getElementsByTagName("parsererror").length > 0) {
      debugError("SVG parser error", doc.getElementsByTagName("parsererror")[0].textContent || "parsererror");
      throw new Error("The selected file is not a valid SVG.");
    }

    auditSvgDocument(doc, "BEFORE sanitising/inlining");

    removeUnsafeDynamicContent(doc);
    debugLog("unsafe dynamic content removed");

    await inlineExternalStylesheets(doc);
    debugLog("external stylesheets inlined");

    const xlinkNs = "http://www.w3.org/1999/xlink";

    // SVG elements capable of loading an external image/document.
    const resourceNodes = doc.querySelectorAll("image, feImage, use");
    debugLog("SVG href resource nodes", resourceNodes.length);
    for (let i = 0; i < resourceNodes.length; i++) {
      const el = resourceNodes[i] as Element;
      await inlineHrefAttribute(el, "href");
      await inlineHrefAttribute(el, "xlink:href", xlinkNs);
    }

    // HTML images can exist inside <foreignObject>.
    const htmlImages = doc.querySelectorAll("img[src], img[srcset]");
    debugLog("HTML image nodes", htmlImages.length);
    for (let i = 0; i < htmlImages.length; i++) {
      const el = htmlImages[i] as Element;
      const src = el.getAttribute("src") || "";
      if (src && !isInlineResourceUrl(src)) {
        debugLog("inline HTML img src", { index: i, src: shortenDebugValue(src) });
        el.setAttribute("src", await fetchResourceAsDataUrl(src));
      }
      if (el.getAttribute("srcset")) await inlineSrcsetAttribute(el);
    }

    // Media poster/source references inside foreignObject can also taint a canvas.
    const mediaNodes = doc.querySelectorAll(
      "video[src], video[poster], audio[src], source[src], source[srcset], input[type='image'][src]"
    );
    debugLog("HTML media resource nodes", mediaNodes.length);
    for (let i = 0; i < mediaNodes.length; i++) {
      const el = mediaNodes[i] as Element;
      const attrs = ["src", "poster"];
      for (let a = 0; a < attrs.length; a++) {
        const attr = attrs[a];
        const value = el.getAttribute(attr);
        if (value && !isInlineResourceUrl(value)) {
          debugLog("inline HTML media attr", { element: el.tagName, attr, value: shortenDebugValue(value) });
          el.setAttribute(attr, await fetchResourceAsDataUrl(value));
        }
      }
      if (el.getAttribute("srcset")) await inlineSrcsetAttribute(el);
    }

    // Inline CSS url(...) references used by style attributes or <style> blocks.
    const allNodes = doc.querySelectorAll("*");
    for (let i = 0; i < allNodes.length; i++) {
      const el = allNodes[i] as Element;
      const styleAttr = el.getAttribute("style");
      if (styleAttr && (/url\(/i.test(styleAttr) || /@import/i.test(styleAttr))) {
        debugLog("inline style attribute URLs", { element: el.tagName, style: shortenDebugValue(styleAttr) });
        let css = await inlineCssImports(styleAttr);
        css = await inlineCssUrls(css);
        el.setAttribute("style", css);
      }
    }

    const styleNodes = doc.getElementsByTagName("style");
    for (let i = 0; i < styleNodes.length; i++) {
      const styleNode = styleNodes[i];
      let cssText = styleNode.textContent || "";
      if (/@import/i.test(cssText)) {
        debugLog(`inline @import from style[${i}]`, shortenDebugValue(cssText, 500));
        cssText = await inlineCssImports(cssText);
      }
      if (/url\(/i.test(cssText)) {
        debugLog(`inline url(...) from style[${i}]`, shortenDebugValue(cssText, 500));
        cssText = await inlineCssUrls(cssText);
      }
      styleNode.textContent = cssText;
    }

    // IMPORTANT diagnostic/fix: any remaining href/xlink:href on non-link SVG nodes
    // can load a resource that the earlier selector list did not cover (for example
    // font-face-uri, mpath, color-profile, textPath in unusual exported SVGs).
    const hrefNodes = doc.querySelectorAll("[href], [xlink\\:href]");
    for (let i = 0; i < hrefNodes.length; i++) {
      const el = hrefNodes[i] as Element;
      const tag = el.tagName.toLowerCase();

      // Hyperlinks are not required for raster output. Remove external navigation URLs
      // instead of fetching HTML into the image.
      if (tag === "a") {
        const href = el.getAttribute("href") || el.getAttributeNS(xlinkNs, "href") || "";
        if (href && !isInlineResourceUrl(href)) {
          debugWarn("removed external <a> hyperlink for raster safety", shortenDebugValue(href));
          el.removeAttribute("href");
          el.removeAttributeNS(xlinkNs, "href");
          el.removeAttribute("xlink:href");
        }
        continue;
      }

      await inlineHrefAttribute(el, "href");
      await inlineHrefAttribute(el, "xlink:href", xlinkNs);
    }

    auditSvgDocument(doc, "AFTER sanitising/inlining");

    // Final defence: inspect ALL resource-like attributes rather than only a few known tags.
    const remainingExternal: Array<{ element: string; attribute: string; value: string }> = [];
    const finalNodes = doc.querySelectorAll("*");
    for (let i = 0; i < finalNodes.length; i++) {
      const el = finalNodes[i] as Element;
      for (let a = 0; a < el.attributes.length; a++) {
        const attr = el.attributes[a];
        const name = attr.name.toLowerCase();
        const value = attr.value || "";
        const directUrlAttr =
          name === "href" || name === "xlink:href" || name === "src" || name === "poster" || name === "data";
        const srcsetAttr = name === "srcset";
        const cssLike = name === "style" || /url\(/i.test(value) || /@import/i.test(value);

        let external = false;
        if (directUrlAttr) external = !!value && !isInlineResourceUrl(value);
        else if (srcsetAttr) {
          // At this point any plain http/blob/relative token in srcset is suspicious.
          external = /(?:https?:\/\/|blob:|^\s*\/|(?:^|,|\s)[^,\s]+\.(?:png|jpe?g|gif|webp|svg)(?:\s|,|$))/i.test(value) && value.toLowerCase().indexOf("data:") !== 0;
        } else if (cssLike) external = cssContainsExternalUrl(value);

        if (external) {
          remainingExternal.push({ element: el.tagName, attribute: attr.name, value: shortenDebugValue(value) });
        }
      }
    }

    if (remainingExternal.length > 0) {
      debugError("remaining external resources BEFORE drawImage", remainingExternal);
      throw new Error(
        `SVG still contains ${remainingExternal.length} external resource reference(s). ` +
        `Open DevTools Console and search for ${SVG_WEBP_DEBUG_PREFIX}.`
      );
    }

    const serialized = new XMLSerializer().serializeToString(doc.documentElement);
    auditSerializedSvg(serialized, "FINAL prepared SVG");

    // Make the exact prepared SVG available in DevTools for temporary debugging.
    try {
      (window as any).__svgWebpLastPreparedSvg = serialized;
      (window as any).__svgWebpLastOriginalSvg = svgText;
      debugLog("DevTools globals ready", {
        prepared: "window.__svgWebpLastPreparedSvg",
        original: "window.__svgWebpLastOriginalSvg"
      });
    } catch {
      // no-op
    }

    return serialized;
  } catch (err: unknown) {
    debugError("prepareSvgForCanvas FAILED", getErrorMessage(err));
    throw err;
  } finally {
    debugGroupEnd();
  }
}

function removeNodesForDiagnostic(svgText: string, selector: string, removeStyleAttributes: boolean = false): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const nodes = doc.querySelectorAll(selector);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  if (removeStyleAttributes) {
    const all = doc.querySelectorAll("[style]");
    for (let i = 0; i < all.length; i++) (all[i] as Element).removeAttribute("style");
  }

  return new XMLSerializer().serializeToString(doc.documentElement);
}

async function probeSvgOriginClean(svgText: string, label: string): Promise<boolean> {
  const svgDataUrl = await svgTextToDataUrl(svgText);

  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`diagnostic image load failed: ${label}`));
      img.src = svgDataUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("diagnostic canvas unavailable");
    ctx.drawImage(img, 0, 0, 128, 128);

    // Reading pixels gives a synchronous, unambiguous origin-clean test.
    ctx.getImageData(0, 0, 1, 1);
    debugLog(`TAINT PROBE PASS ✅ — ${label}`);
    return true;
  } catch (err: unknown) {
    debugWarn(`TAINT PROBE FAIL ❌ — ${label}`, getErrorMessage(err));
    return false;
  }
}

async function diagnoseTaintedPreparedSvg(svgText: string): Promise<void> {
  debugGroup("AUTOMATIC TAINT DIAGNOSIS");
  try {
    debugError("The full prepared SVG tainted the canvas. Running isolation probes now.");

    const variants: Array<{ label: string; svg: string }> = [
      { label: "remove <foreignObject>", svg: removeNodesForDiagnostic(svgText, "foreignObject") },
      { label: "remove <image>, <feImage>, <use>", svg: removeNodesForDiagnostic(svgText, "image, feImage, use") },
      { label: "remove <style>/<link> + style attributes", svg: removeNodesForDiagnostic(svgText, "style, link", true) },
      { label: "remove filter/mask/pattern/clipPath", svg: removeNodesForDiagnostic(svgText, "filter, mask, pattern, clipPath") },
      {
        label: "remove all high-risk resource containers",
        svg: removeNodesForDiagnostic(svgText, "foreignObject, image, feImage, use, style, link, filter, mask, pattern, clipPath", true)
      }
    ];

    for (let i = 0; i < variants.length; i++) {
      await probeSvgOriginClean(variants[i].svg, variants[i].label);
    }

    // If there are only a few high-risk elements, remove them one-by-one and test.
    // This often identifies the exact offending node in exported SVGs.
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const risky = doc.querySelectorAll("foreignObject, image, feImage, use, style, link");
    debugLog("high-risk elements available for one-by-one probe", risky.length);

    if (risky.length > 0 && risky.length <= 12) {
      for (let i = 0; i < risky.length; i++) {
        const fresh = parser.parseFromString(svgText, "image/svg+xml");
        const freshRisky = fresh.querySelectorAll("foreignObject, image, feImage, use, style, link");
        const target = freshRisky[i] as Element;
        const targetPreview = target ? shortenDebugValue(new XMLSerializer().serializeToString(target), 700) : "unknown";
        if (target && target.parentNode) target.parentNode.removeChild(target);
        const variant = new XMLSerializer().serializeToString(fresh.documentElement);
        const clean = await probeSvgOriginClean(variant, `remove risky node #${i + 1} <${target ? target.tagName : "?"}>`);
        if (clean) {
          debugError("LIKELY TAINTING ELEMENT FOUND", { index: i + 1, element: target ? target.tagName : "?", markup: targetPreview });
        }
      }
    } else if (risky.length > 12) {
      debugWarn("one-by-one probe skipped because there are too many high-risk elements", risky.length);
    }

    debugLog("Copy prepared SVG if needed with: copy(window.__svgWebpLastPreparedSvg)");
  } catch (err: unknown) {
    debugError("automatic taint diagnosis failed", getErrorMessage(err));
  } finally {
    debugGroupEnd();
  }
}

async function svgTextToWebpBlob(svgText: string, outW: number, outH: number, quality: number): Promise<Blob> {
  debugGroup("svgTextToWebpBlob");
  debugLog("conversion parameters", { outW, outH, quality, build: SVG_WEBP_DEBUG_BUILD });

  // IMPORTANT: inline linked images/resources first. Otherwise drawImage() can
  // taint the canvas and canvas.toBlob() throws "Tainted canvases may not be exported".
  const canvasSafeSvgText = await prepareSvgForCanvas(svgText);

  // IMPORTANT: use a data: URL for the OUTER SVG instead of a blob: URL.
  // Chromium has a long-standing/special security path where SVGs containing
  // <foreignObject> can taint a canvas when loaded from blob:, even if all
  // referenced resources are already embedded. A data: URL avoids that path.
  const svgDataUrl = await svgTextToDataUrl(canvasSafeSvgText);
  debugLog("prepared SVG data URL created", {
    svgTextLength: canvasSafeSvgText.length,
    dataUrlLength: svgDataUrl.length,
    prefix: svgDataUrl.substring(0, 48)
  });

  try {
    const img = new Image();
    img.decoding = "async";

    debugLog("loading prepared SVG into Image → start");
    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        debugLog("loading prepared SVG into Image → onload", {
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          complete: img.complete,
          currentSrc: shortenDebugValue(img.currentSrc || img.src, 300)
        });
        resolve();
      };
      img.onerror = (ev) => {
        debugError("loading prepared SVG into Image → onerror", ev);
        reject(new Error("Failed to load SVG into image"));
      };
      img.src = svgDataUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    debugLog("canvas created", { width: canvas.width, height: canvas.height });

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not supported in this browser");

    ctx.clearRect(0, 0, outW, outH);
    debugLog("drawImage → START");
    ctx.drawImage(img, 0, 0, outW, outH);
    debugLog("drawImage → DONE");

    // Immediate origin-clean check. This tells us whether drawImage itself tainted
    // the canvas, before WebP export is attempted.
    try {
      ctx.getImageData(0, 0, 1, 1);
      debugLog("origin-clean test after drawImage → PASS ✅");
    } catch (originErr: unknown) {
      debugError("origin-clean test after drawImage → FAIL ❌ CANVAS IS TAINTED", {
        error: getErrorMessage(originErr),
        name: originErr instanceof Error ? originErr.name : "unknown"
      });
      await diagnoseTaintedPreparedSvg(canvasSafeSvgText);
      throw new Error(
        `Canvas became tainted immediately after drawImage: ${getErrorMessage(originErr)}. ` +
        `Open DevTools Console and filter for ${SVG_WEBP_DEBUG_PREFIX}.`
      );
    }

    debugLog("canvas.toBlob(image/webp) → START", { quality });
    const blob = await new Promise<Blob>((resolve, reject) => {
      try {
        canvas.toBlob(
          (b) => {
            if (b) {
              debugLog("canvas.toBlob(image/webp) → SUCCESS", { type: b.type, size: b.size });
              resolve(b);
            } else {
              debugError("canvas.toBlob(image/webp) → NULL BLOB");
              reject(new Error("WebP export failed (browser may not support WebP)"));
            }
          },
          "image/webp",
          quality
        );
      } catch (err: unknown) {
        debugError("canvas.toBlob(image/webp) → THREW", {
          error: getErrorMessage(err),
          name: err instanceof Error ? err.name : "unknown"
        });
        reject(new Error(`WebP export failed: ${getErrorMessage(err)}`));
      }
    });

    debugLog("conversion complete", { type: blob.type, size: blob.size });
    return blob;
  } catch (err: unknown) {
    debugError("svgTextToWebpBlob FAILED", getErrorMessage(err));
    throw err;
  } finally {
    debugGroupEnd();
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function fileListToArray(files: FileList): File[] {
  const arr: File[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files.item(i);
    if (f) arr.push(f);
  }
  return arr;
}

function isSvgFileName(name: string): boolean {
  return /\.svg$/i.test(name);
}

function stripSvgExt(name: string): string {
  return name.replace(/\.svg$/i, "");
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

export default function SvGtoWebP(): JSX.Element {
  const [items, setItems] = React.useState<ConvertItem[]>([]);
  const [quality, setQuality] = React.useState<number>(0.9);
  const [scale, setScale] = React.useState<number>(1);
  const [busy, setBusy] = React.useState<boolean>(false);
  const [msg, setMsg] = React.useState<{ type: MessageBarType; text: string } | null>(null);

  // ✅ Fix: re-upload same file after Clear (force input remount)
  const [fileInputKey, setFileInputKey] = React.useState<number>(1);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Dropzone UI state
  const [dragOver, setDragOver] = React.useState<boolean>(false);

  React.useEffect(() => {
    debugLog("WEB PART LOADED", { build: SVG_WEBP_DEBUG_BUILD, href: window.location.href });
    debugLog(`Filter DevTools Console by: ${SVG_WEBP_DEBUG_PREFIX}`);
  }, []);

  const scaleOptions: IDropdownOption[] = [
    { key: 1, text: "1x (same size)" },
    { key: 2, text: "2x (sharper)" },
    { key: 3, text: "3x" },
    { key: 4, text: "4x" }
  ];

  const readFileAsText = (f: File): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsText(f);
    });
  };

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;

    setMsg(null);

    const all = fileListToArray(files);
    const svgFiles: File[] = all.filter((f: File) => isSvgFileName(f.name));

    if (svgFiles.length === 0) {
      setMsg({ type: MessageBarType.warning, text: "Please select SVG files only." });
      return;
    }

    const newItems: ConvertItem[] = [];
    for (let i = 0; i < svgFiles.length; i++) {
      const f = svgFiles[i];
      const svgText = await readFileAsText(f);
      const dims = getSvgDimensions(svgText);
      debugLog("SVG FILE ADDED", {
        fileName: f.name,
        fileSize: f.size,
        fileType: f.type,
        svgTextLength: svgText.length,
        widthPx: dims.widthPx,
        heightPx: dims.heightPx,
        hasForeignObject: /<foreignObject\b/i.test(svgText),
        hasImage: /<image\b/i.test(svgText),
        hasUse: /<use\b/i.test(svgText),
        hasHttp: /https?:\/\//i.test(svgText),
        hasBlob: /blob:/i.test(svgText),
        hasCssUrl: /url\(/i.test(svgText)
      });

      newItems.push({
        file: f,
        name: stripSvgExt(f.name),
        svgText,
        widthPx: dims.widthPx,
        heightPx: dims.heightPx,
        status: "queued"
      });
    }

    setItems((prev) => prev.concat(newItems));

    // ✅ allow selecting same file again
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const convertAll = async (): Promise<void> => {
    if (items.length === 0) {
      setMsg({ type: MessageBarType.info, text: "Upload at least one SVG first." });
      return;
    }

    setBusy(true);
    setMsg(null);

    try {
      let failureCount = 0;
      debugLog("CONVERT ALL → START", { files: items.length, scale, quality, build: SVG_WEBP_DEBUG_BUILD });
      setItems((prev) =>
        prev.map((it) => (it.status === "queued" ? { ...it, status: "converting", error: undefined } : it))
      );

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.status === "done" && it.webpBlob) continue;

        try {
          const outW = Math.max(1, Math.round(it.widthPx * scale));
          const outH = Math.max(1, Math.round(it.heightPx * scale));

          // let UI breathe
          await new Promise<void>((r) => setTimeout(r, 0));

          const blob = await svgTextToWebpBlob(it.svgText, outW, outH, quality);
          const url = URL.createObjectURL(blob);

          setItems((prev) =>
            prev.map((p) =>
              p.file === it.file ? { ...p, status: "done", webpBlob: blob, webpUrl: url } : p
            )
          );
        } catch (err: unknown) {
          failureCount++;
          const message = getErrorMessage(err);
          debugError("FILE CONVERSION FAILED", { file: it.file.name, error: message });
          setItems((prev) =>
            prev.map((p) => (p.file === it.file ? { ...p, status: "error", error: message } : p))
          );
        }
      }

      if (failureCount > 0) {
        setMsg({
          type: MessageBarType.error,
          text: `${failureCount} file(s) failed. Open DevTools Console and filter for ${SVG_WEBP_DEBUG_PREFIX}.`
        });
      } else {
        setMsg({ type: MessageBarType.success, text: "Conversion completed." });
      }
      debugLog("CONVERT ALL → END", { failures: failureCount, total: items.length });
    } finally {
      setBusy(false);
    }
  };

  const downloadAll = (): void => {
    const done = items.filter((i) => i.status === "done" && !!i.webpBlob);
    if (done.length === 0) {
      setMsg({ type: MessageBarType.info, text: "No converted files to download yet." });
      return;
    }
    done.forEach((i) => downloadBlob(i.webpBlob as Blob, `${i.name}.webp`));
  };

  const removeOne = (idx: number): void => {
    setItems((prev) => {
      const next = prev.slice();
      const it = next[idx];
      if (it && it.webpUrl) URL.revokeObjectURL(it.webpUrl);
      next.splice(idx, 1);
      return next;
    });
  };

  const clearAll = (): void => {
    items.forEach((i) => {
      if (i.webpUrl) URL.revokeObjectURL(i.webpUrl);
    });
    setItems([]);
    setMsg(null);

    // ✅ Fix: force input remount so selecting same file triggers again
    setFileInputKey((k) => k + 1);

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onDrop = async (ev: React.DragEvent<HTMLDivElement>): Promise<void> => {
    ev.preventDefault();
    setDragOver(false);
    const dt = ev.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
      await addFiles(dt.files);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <div className={styles.badge}>
            <Icon iconName="Picture" />
          </div>
          <div>
            <Text variant="xxLarge" className={styles.title}>SVG → WebP Converter</Text>
            <Text className={styles.subTitle}>
              Upload one or many SVGs. Output WebP keeps the same dimensions from SVG width/height (or viewBox).
            </Text>
          </div>
        </div>

        <div className={styles.stats}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Files</div>
            <div className={styles.statValue}>{items.length}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Scale</div>
            <div className={styles.statValue}>{scale}x</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Quality</div>
            <div className={styles.statValue}>{quality.toFixed(2)}</div>
          </div>
        </div>
      </div>

      {msg && (
        <MessageBar messageBarType={msg.type} className={styles.msg}>
          {msg.text}
        </MessageBar>
      )}

      <div
        className={`${styles.dropZone} ${dragOver ? styles.dropZoneOver : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className={styles.dropInner}>
          <div className={styles.dropIcon}>
            <Icon iconName="CloudUpload" />
          </div>

          <div className={styles.dropText}>
            <div className={styles.dropTitle}>Drag & drop SVG files here</div>
            <div className={styles.dropSub}>or browse to upload (single or multiple)</div>
          </div>

          <div className={styles.dropActions}>
            <input
              key={fileInputKey}
              ref={(r) => (fileInputRef.current = r)}
              className={styles.fileInput}
              type="file"
              accept=".svg,image/svg+xml"
              multiple
              onChange={(e) => addFiles(e.target.files)}
              disabled={busy}
            />
            <PrimaryButton
              text="Browse SVG(s)"
              iconProps={{ iconName: "FolderOpen" }}
              disabled={busy}
              onClick={() => {
                if (fileInputRef.current) fileInputRef.current.click();
              }}
            />
          </div>
        </div>

        <div className={styles.controls}>
          <div className={styles.controlGrid}>
            <div className={styles.controlItem}>
              <div className={styles.controlLabel}>Scale</div>
              <Dropdown
                options={scaleOptions}
                selectedKey={scale}
                onChange={(_, opt) => setScale(Number(opt ? opt.key : 1))}
                disabled={busy}
              />
            </div>

            <div className={styles.controlItem}>
              <div className={styles.controlLabel}>Quality</div>
              <div className={styles.qualityWrap}>
                <input
                  className={styles.range}
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  disabled={busy}
                />
                <div className={styles.qualityPill}>{quality.toFixed(2)}</div>
              </div>
            </div>

            <div className={styles.controlItemButtons}>
              <Stack horizontal tokens={{ childrenGap: 10 }} className={styles.buttons}>
                <PrimaryButton
                  text="Convert"
                  iconProps={{ iconName: "LightningBolt" }}
                  onClick={convertAll}
                  disabled={busy || items.length === 0}
                />
                <DefaultButton
                  text="Download all"
                  iconProps={{ iconName: "Download" }}
                  onClick={downloadAll}
                  disabled={busy}
                />
                <DefaultButton
                  text="Clear"
                  iconProps={{ iconName: "Delete" }}
                  onClick={clearAll}
                  disabled={busy && items.length > 0}
                />
              </Stack>
            </div>
          </div>

          {busy && (
            <div className={styles.progressWrap}>
              <ProgressIndicator label="Converting…" />
            </div>
          )}
        </div>
      </div>

      <div className={styles.list}>
        {items.length === 0 ? (
          <div className={styles.empty}>
            <Icon iconName="Info" className={styles.emptyIcon} />
            <div>
              <div className={styles.emptyTitle}>No files uploaded yet</div>
              <div className={styles.emptySub}>Drop SVGs above to start converting.</div>
            </div>
          </div>
        ) : (
          items.map((it, idx) => {
            const outW = Math.round(it.widthPx * scale);
            const outH = Math.round(it.heightPx * scale);

            return (
              <div className={styles.card} key={`${it.name}-${idx}`}>
                <div className={styles.cardLeft}>
                  <div className={styles.fileMeta}>
                    <div className={styles.fileTitle}>
                      <Icon iconName="FileImage" /> {it.file.name}
                    </div>
                    <div className={styles.fileDims}>
                      SVG: <b>{it.widthPx}×{it.heightPx}</b> → WebP: <b>{outW}×{outH}</b>
                    </div>
                  </div>

                  <div className={styles.statusRow}>
                    {it.status === "queued" && <span className={styles.chip}>Queued</span>}
                    {it.status === "converting" && (
                      <span className={styles.chip}>
                        <Spinner size={SpinnerSize.xSmall} className={styles.spin} /> Converting
                      </span>
                    )}
                    {it.status === "done" && <span className={styles.chipDone}>Done</span>}
                    {it.status === "error" && <span className={styles.chipErr}>Error</span>}
                    {it.error && <div className={styles.errText}>{it.error}</div>}
                  </div>
                </div>

                <div className={styles.cardRight}>
                  {it.status === "done" && it.webpBlob && (
                    <>
                      <DefaultButton
                        text="Download"
                        iconProps={{ iconName: "Download" }}
                        onClick={() => downloadBlob(it.webpBlob as Blob, `${it.name}.webp`)}
                      />

                      {it.webpUrl && (
                        <a className={styles.previewLink} href={it.webpUrl} target="_blank" rel="noreferrer">
                          Preview
                        </a>
                      )}

                      {it.webpUrl && (
                        <div className={styles.thumbWrap} title={`${outW}×${outH}`}>
                          <img
                            className={styles.thumb}
                            src={it.webpUrl}
                            alt={`${it.name} preview`}
                            loading="lazy"
                            decoding="async"
                          />
                        </div>
                      )}
                    </>
                  )}

                  <DefaultButton
                    text="Remove"
                    iconProps={{ iconName: "Cancel" }}
                    onClick={() => removeOne(idx)}
                    disabled={busy}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
