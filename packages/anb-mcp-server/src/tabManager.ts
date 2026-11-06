/**
 * ANB Tab Manager & DOM Session
 * Manages browser tabs, DOM state, and navigation history.
 */

import type { BrowserTab } from '@anb/core';
import { AriaSnapshotEngine, type AriaSnapshotResult, type AriaNode } from './ariaSnapshot.js';

export interface DOMElement {
  id: string;
  tagName: string;
  role?: string;
  text?: string;
  attributes?: Record<string, string>;
  value?: string;
  href?: string;
  refId?: string;
}

export interface TabSession {
  tab: BrowserTab;
  content: string;
  elements: Map<string, DOMElement>;
  history: string[];
  lastAriaSnapshot?: AriaSnapshotResult;
}

export class TabManager {
  private tabs: Map<string, TabSession> = new Map();
  private activeTabId: string = '';
  private nextId = 1;

  constructor() {
    // Initialize default blank tab
    this.createTab('about:blank', 'New Tab');
  }

  createTab(url: string = 'about:blank', title: string = 'New Tab'): BrowserTab {
    const tabId = `tab_${this.nextId++}`;
    const tab: BrowserTab = {
      tabId,
      url,
      title,
      isActive: true
    };

    // Deactivate previous active tab
    if (this.activeTabId && this.tabs.has(this.activeTabId)) {
      this.tabs.get(this.activeTabId)!.tab.isActive = false;
    }

    const session: TabSession = {
      tab,
      content: `<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
      elements: new Map(),
      history: [url]
    };

    this.tabs.set(tabId, session);
    this.activeTabId = tabId;
    return tab;
  }

  listTabs(): BrowserTab[] {
    return Array.from(this.tabs.values()).map(s => s.tab);
  }

  getActiveTab(): BrowserTab | null {
    if (!this.activeTabId || !this.tabs.has(this.activeTabId)) return null;
    return this.tabs.get(this.activeTabId)!.tab;
  }

  activateTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) return false;
    for (const [id, s] of this.tabs.entries()) {
      s.tab.isActive = (id === tabId);
    }
    this.activeTabId = tabId;
    return true;
  }

  closeTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) return false;
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      const remaining = Array.from(this.tabs.keys());
      if (remaining.length > 0) {
        this.activateTab(remaining[0]);
      } else {
        this.activeTabId = '';
      }
    }
    return true;
  }

  async navigate(tabId: string, url: string, mockContent?: string, mockTitle?: string): Promise<{ finalUrl: string; title: string }> {
    const session = this.tabs.get(tabId);
    if (!session) throw new Error(`Tab '${tabId}' not found.`);

    session.tab.url = url;
    session.tab.title = mockTitle || (url.startsWith('http') ? new URL(url).hostname : url);
    session.history.push(url);

    if (mockContent) {
      session.content = mockContent;
      this.parseMockElements(session, mockContent);
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      try {
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
          }
        });
        const html = await resp.text();
        session.content = html;

        // Extract title from real HTML
        const titleMatch = /<title[^>]*>(.*?)<\/title>/i.exec(html);
        if (titleMatch && titleMatch[1]) {
          session.tab.title = titleMatch[1].trim();
        }
        this.parseMockElements(session, html);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        session.content = `<html><head><title>Error</title></head><body><h1>접속 실패</h1><p>${msg}</p></body></html>`;
      }
    } else {
      session.content = `<html><head><title>${session.tab.title}</title></head><body><p>Content of ${url}</p></body></html>`;
    }

    // Always generate ARIA accessibility snapshot
    const aria = AriaSnapshotEngine.generateSnapshot(session.content, session.tab.url, session.tab.title);
    session.lastAriaSnapshot = aria;
    for (const [ref, node] of aria.elementMap.entries()) {
      if (!session.elements.has(ref)) {
        session.elements.set(ref, {
          id: ref,
          refId: ref,
          tagName: node.tagName,
          role: node.role,
          text: node.name,
          value: node.value,
          href: node.href,
          attributes: node.attributes
        });
      }
    }

    return {
      finalUrl: session.tab.url,
      title: session.tab.title
    };
  }

  getAriaSnapshot(tabId: string): AriaSnapshotResult {
    const session = this.tabs.get(tabId);
    if (!session) throw new Error(`Tab '${tabId}' not found.`);
    if (!session.lastAriaSnapshot) {
      session.lastAriaSnapshot = AriaSnapshotEngine.generateSnapshot(session.content, session.tab.url, session.tab.title);
    }
    return session.lastAriaSnapshot;
  }

  getSnapshot(tabId: string): string {
    const session = this.tabs.get(tabId);
    if (!session) throw new Error(`Tab '${tabId}' not found.`);

    // Extract textual representation of DOM/accessibility tree
    const lines: string[] = [
      `[URL]: ${session.tab.url}`,
      `[TITLE]: ${session.tab.title}`,
      `[ELEMENTS]:`
    ];

    if (session.elements.size === 0) {
      lines.push(`  (Document body: ${session.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()})`);
    } else {
      for (const el of session.elements.values()) {
        const role = el.role ? `[role=${el.role}]` : `[${el.tagName}]`;
        const text = el.text ? ` "${el.text}"` : '';
        const val = el.value ? ` value="${el.value}"` : '';
        lines.push(`  - ID: ${el.id} ${role}${text}${val}`);
      }
    }

    return lines.join('\n');
  }

  findElement(tabId: string, query: { role?: string; text?: string; selector?: string; refId?: string }): DOMElement | null {
    const session = this.tabs.get(tabId);
    if (!session) throw new Error(`Tab '${tabId}' not found.`);

    if (query.refId && session.elements.has(query.refId)) {
      return session.elements.get(query.refId)!;
    }

    for (const el of session.elements.values()) {
      if (query.selector && (el.id === query.selector.replace('#', '') || el.refId === query.selector.replace('#', ''))) return el;
      if (query.role && el.role === query.role) return el;
      if (query.text && el.text && el.text.toLowerCase().includes(query.text.toLowerCase())) return el;
    }
    return null;
  }

  typeElement(tabId: string, elementId: string, text: string): DOMElement {
    const session = this.tabs.get(tabId);
    if (!session) throw new Error(`Tab '${tabId}' not found.`);
    const el = session.elements.get(elementId);
    if (!el) throw new Error(`Element '${elementId}' not found in tab '${tabId}'.`);
    el.value = text;
    return el;
  }

  extractText(tabId: string): { url: string; title: string; text: string } {
    const session = this.tabs.get(tabId);
    if (!session) throw new Error(`Tab '${tabId}' not found.`);
    const plainText = session.content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      url: session.tab.url,
      title: session.tab.title,
      text: plainText
    };
  }

  private parseMockElements(session: TabSession, html: string) {
    session.elements.clear();
    let elemIndex = 1;

    // Simple parser for standard mock fixtures
    const buttonRegex = /<button[^>]*id=["']([^"']+)["'][^>]*>(.*?)<\/button>/gi;
    let match;
    while ((match = buttonRegex.exec(html)) !== null) {
      session.elements.set(match[1], {
        id: match[1],
        tagName: 'button',
        role: 'button',
        text: match[2].trim()
      });
    }

    const inputRegex = /<input[^>]*id=["']([^"']+)["'][^>]*type=["']([^"']+)["'][^>]*>/gi;
    while ((match = inputRegex.exec(html)) !== null) {
      session.elements.set(match[1], {
        id: match[1],
        tagName: 'input',
        role: match[2],
        attributes: { type: match[2] }
      });
    }

    const aRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
    while ((match = aRegex.exec(html)) !== null) {
      const id = `link_${elemIndex++}`;
      session.elements.set(id, {
        id,
        tagName: 'a',
        role: 'link',
        text: match[2].trim(),
        attributes: { href: match[1] }
      });
    }
  }
}
