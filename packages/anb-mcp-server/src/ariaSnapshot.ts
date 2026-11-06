/**
 * ARIA Snapshot Engine
 * Converts raw HTML / DOM trees into compact, semantic Accessibility Trees
 * for LLM vision and precise element targeting.
 */

export interface AriaNode {
  refId: string;
  role: string;
  name?: string;
  value?: string;
  href?: string;
  level?: number;
  tagName: string;
  attributes: Record<string, string>;
  children?: AriaNode[];
  isInteractive: boolean;
}

export interface AriaSnapshotResult {
  title: string;
  url: string;
  snapshotText: string;
  hasCaptcha: boolean;
  captchaType?: string;
  elementMap: Map<string, AriaNode>;
  interactiveCount: number;
}

export class AriaSnapshotEngine {
  private static CAPTCHA_PATTERNS = [
    { type: 'reCAPTCHA', regex: /(?:g-recaptcha|google\.com\/recaptcha|recaptcha\/api)/i },
    { type: 'Cloudflare Turnstile', regex: /(?:cf-turnstile|challenges\.cloudflare\.com|turnstile)/i },
    { type: 'hCaptcha', regex: /(?:hcaptcha\.com|h-captcha)/i },
    { type: 'Generic Captcha', regex: /(?:captcha_image|captcha_input|kaptcha|bot_detect)/i }
  ];

  public static generateSnapshot(html: string, url: string = '', title: string = ''): AriaSnapshotResult {
    const elementMap = new Map<string, AriaNode>();
    let refCounter = 1;

    // 1. Check for CAPTCHA
    let hasCaptcha = false;
    let captchaType: string | undefined;
    for (const pat of this.CAPTCHA_PATTERNS) {
      if (pat.regex.test(html)) {
        hasCaptcha = true;
        captchaType = pat.type;
        break;
      }
    }

    // 2. Clean HTML: strip scripts, styles, svg content
    const sanitizedHtml = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '[icon]');

    // 3. Extract title if not provided
    let extractedTitle = title;
    if (!extractedTitle) {
      const tm = /<title[^>]*>(.*?)<\/title>/i.exec(sanitizedHtml);
      if (tm && tm[1]) extractedTitle = tm[1].trim();
    }

    const lines: string[] = [
      `# Page: ${extractedTitle || 'Untitled'} (${url || 'about:blank'})`,
      hasCaptcha ? `> ⚠️ [CAPTCHA DETECTED: ${captchaType}] - Requires Human Intervention` : ''
    ].filter(Boolean);

    // 4. Extract Headings (H1 ~ H4)
    const headingRegex = /<(h[1-4])[^>]*>(.*?)<\/\1>/gi;
    let hMatch;
    const headings: string[] = [];
    while ((hMatch = headingRegex.exec(sanitizedHtml)) !== null) {
      const level = parseInt(hMatch[1][1], 10);
      const text = this.stripTags(hMatch[2]).trim();
      if (text && text.length < 120 && !headings.includes(text)) {
        headings.push(text);
        const refId = `ref${refCounter++}`;
        const node: AriaNode = {
          refId,
          role: 'heading',
          name: text,
          level,
          tagName: hMatch[1].toLowerCase(),
          attributes: {},
          isInteractive: false
        };
        elementMap.set(refId, node);
      }
    }
    if (headings.length > 0) {
      lines.push('\n## Headings & Structure:');
      for (const h of headings.slice(0, 10)) {
        lines.push(`  - heading "${h}"`);
      }
    }

    // 5. Extract Search & Text Inputs
    const inputRegex = /<input\b([^>]*)>/gi;
    let inMatch;
    const inputs: AriaNode[] = [];
    while ((inMatch = inputRegex.exec(sanitizedHtml)) !== null) {
      const attrs = this.parseAttributes(inMatch[1]);
      const type = (attrs['type'] || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'image'].includes(type)) continue;

      const name = attrs['placeholder'] || attrs['aria-label'] || attrs['title'] || attrs['name'] || attrs['id'] || type;
      const refId = `ref${refCounter++}`;
      const node: AriaNode = {
        refId,
        role: type === 'search' || (attrs['name'] && /query|search|keyword/i.test(attrs['name'])) ? 'searchbox' : 'textbox',
        name,
        value: attrs['value'] || '',
        tagName: 'input',
        attributes: attrs,
        isInteractive: true
      };
      elementMap.set(refId, node);
      inputs.push(node);
    }

    // 6. Extract Buttons
    const buttonRegex = /<button\b([^>]*)>(.*?)<\/button>/gi;
    let btnMatch;
    const buttons: AriaNode[] = [];
    while ((btnMatch = buttonRegex.exec(sanitizedHtml)) !== null) {
      const attrs = this.parseAttributes(btnMatch[1]);
      const innerText = this.stripTags(btnMatch[2]).trim();
      const label = attrs['aria-label'] || attrs['title'] || innerText || 'Button';
      if (label.length > 80) continue;

      const refId = `ref${refCounter++}`;
      const node: AriaNode = {
        refId,
        role: 'button',
        name: label,
        tagName: 'button',
        attributes: attrs,
        isInteractive: true
      };
      elementMap.set(refId, node);
      buttons.push(node);
    }

    // 7. Extract Primary Links
    const linkRegex = /<a\b([^>]*)>(.*?)<\/a>/gi;
    let linkMatch;
    const links: AriaNode[] = [];
    const seenHrefs = new Set<string>();
    while ((linkMatch = linkRegex.exec(sanitizedHtml)) !== null) {
      const attrs = this.parseAttributes(linkMatch[1]);
      const href = attrs['href'];
      const text = this.stripTags(linkMatch[2]).trim();
      if (!href || href === '#' || href.startsWith('javascript:')) continue;
      if (!text || text.length < 2 || text.length > 100) continue;
      if (seenHrefs.has(href)) continue;
      seenHrefs.add(href);

      const refId = `ref${refCounter++}`;
      const node: AriaNode = {
        refId,
        role: 'link',
        name: text,
        href,
        tagName: 'a',
        attributes: attrs,
        isInteractive: true
      };
      elementMap.set(refId, node);
      links.push(node);
    }

    // Format Form Controls
    if (inputs.length > 0) {
      lines.push('\n## Interactive Inputs:');
      for (const inp of inputs) {
        lines.push(`  - [${inp.refId}] ${inp.role} "${inp.name}"${inp.value ? ` value="${inp.value}"` : ''}`);
      }
    }

    // Format Action Buttons
    if (buttons.length > 0) {
      lines.push('\n## Buttons & Actions:');
      for (const b of buttons.slice(0, 15)) {
        lines.push(`  - [${b.refId}] button "${b.name}"`);
      }
    }

    // Format Primary Navigation Links
    if (links.length > 0) {
      lines.push('\n## Navigation & Key Links:');
      for (const l of links.slice(0, 25)) {
        lines.push(`  - [${l.refId}] link "${l.name}" -> ${l.href}`);
      }
    }

    return {
      title: extractedTitle,
      url,
      snapshotText: lines.join('\n'),
      hasCaptcha,
      captchaType,
      elementMap,
      interactiveCount: inputs.length + buttons.length + links.length
    };
  }

  private static stripTags(text: string): string {
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private static parseAttributes(rawAttrs: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const regex = /([a-zA-Z0-9_\-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/g;
    let match;
    while ((match = regex.exec(rawAttrs)) !== null) {
      const key = match[1].toLowerCase();
      const val = match[2] ?? match[3] ?? match[4] ?? '';
      attrs[key] = val;
    }
    return attrs;
  }
}
