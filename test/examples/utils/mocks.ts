// Mock-Implementierungen für pi-spaces Tests
// Bietet Mock-Versionen von externen Abhängigkeiten

import { 
  fauxAssistantMessage, 
  fauxProvider, 
  fauxToolCall 
} from "@earendil-works/pi-ai/providers/faux";

/**
 * Mock arXiv API Client
 * Simuliert arXiv API-Aufrufe mit Test-Daten
 */
export class MockArxivClient {
  private papers: any[];
  private callCount: number = 0;
  private lastQuery: string = "";

  constructor(papers: any[] = []) {
    this.papers = papers.length > 0 ? papers : this.createDefaultPapers();
  }

  /**
   * Erstellt Standard-Test-Papers
   */
  private createDefaultPapers(): any[] {
    return [
      {
        id: "2304.12345",
        title: "Advanced Transformer Architectures",
        authors: ["Author One", "Author Two"],
        abstract: "This paper introduces a new transformer architecture...",
        categories: ["cs.LG", "cs.AI"],
        published: "2023-04-01T00:00:00Z",
        pdfUrl: "https://arxiv.org/pdf/2304.12345.pdf"
      },
      {
        id: "2305.67890",
        title: "Dark Energy Observations from Supernovae",
        authors: ["Astrophysicist One"],
        abstract: "New observations of dark energy from supernova data...",
        categories: ["astro-ph.CO"],
        published: "2023-05-01T00:00:00Z",
        pdfUrl: "https://arxiv.org/pdf/2305.67890.pdf"
      },
      {
        id: "2306.54321",
        title: "Modified Gravity Theories",
        authors: ["Theorist One", "Theorist Two"],
        abstract: "Exploring alternatives to general relativity...",
        categories: ["gr-qc"],
        published: "2023-06-01T00:00:00Z",
        pdfUrl: "https://arxiv.org/pdf/2306.54321.pdf"
      }
    ];
  }

  /**
   * Simuliert arXiv API-Aufruf
   */
  async search(query: string, options: { maxResults?: number; fromYear?: number; toYear?: number } = {}): Promise<any> {
    this.callCount++;
    this.lastQuery = query;

    const { maxResults = 10, fromYear, toYear } = options;

    // Filter Papers nach Query und Jahr
    let results = this.papers.filter(paper => {
      // Query-Filter (einfach)
      const queryMatch = !query || 
        paper.title.toLowerCase().includes(query.toLowerCase()) ||
        paper.abstract.toLowerCase().includes(query.toLowerCase());

      // Jahr-Filter
      const paperYear = new Date(paper.published).getFullYear();
      const yearMatch = (!fromYear || paperYear >= fromYear) && 
                        (!toYear || paperYear <= toYear);

      return queryMatch && yearMatch;
    });

    // Max Results
    results = results.slice(0, maxResults);

    return {
      feed: {
        entry: results
      },
      callCount: this.callCount,
      lastQuery: this.lastQuery
    };
  }

  /**
   * Setzt Test-Papers
   */
  setPapers(papers: any[]): void {
    this.papers = papers;
  }

  /**
   * Fügt Papers hinzu
   */
  addPapers(papers: any[]): void {
    this.papers.push(...papers);
  }

  /**
   * Gibt Aufruf-Statistiken zurück
   */
  getStats(): { callCount: number; lastQuery: string } {
    return { callCount: this.callCount, lastQuery: this.lastQuery };
  }

  /**
   * Setzt Aufzählungen zurück
   */
  resetStats(): void {
    this.callCount = 0;
    this.lastQuery = "";
  }
}

/**
 * Mock LLM Provider
 * Simuliert LLM-Antworten für Tests
 */
export class MockLLMProvider {
  private responses: any[];
  private callCount: number = 0;
  private lastPrompt: string = "";

  constructor(responses: any[] = []) {
    this.responses = responses.length > 0 ? responses : this.createDefaultResponses();
  }

  /**
   * Erstellt Standard-Antworten
   */
  private createDefaultResponses(): any[] {
    return [
      // Klassifikations-Antwort
      {
        relevance: "high",
        topics: ["machine learning", "transformers"],
        keywords: ["attention", "neural networks"],
        confidence: 0.95
      },
      // Zusammenfassungs-Antwort
      {
        summary: "This paper introduces a new approach to...",
        keyFindings: ["Finding 1", "Finding 2", "Finding 3"],
        citationCount: 42
      },
      // Analyse-Antwort
      {
        analysis: "The paper shows significant improvements in...",
        trends: ["Increasing performance", "Reduced training time"],
        limitations: ["Requires more data", "Computationally expensive"]
      },
      // Chat-Antwort
      {
        response: "Based on the available data, the answer is...",
        sources: ["2304.12345", "2305.67890"],
        confidence: 0.9
      }
    ];
  }

  /**
   * Simuliert LLM-Aufruf
   */
  async complete(prompt: string, options: any = {}): Promise<any> {
    this.callCount++;
    this.lastPrompt = prompt;

    // Nächste Antwort aus der Queue
    const response = this.responses[this.callCount % this.responses.length];

    // Simuliere Verzögerung
    if (options.delayMs) {
      await new Promise(resolve => setTimeout(resolve, options.delayMs));
    }

    return {
      ...response,
      callCount: this.callCount,
      lastPrompt: this.lastPrompt
    };
  }

  /**
   * Setzt Antworten
   */
  setResponses(responses: any[]): void {
    this.responses = responses;
  }

  /**
   * Fügt Antwort hinzu
   */
  addResponse(response: any): void {
    this.responses.push(response);
  }

  /**
   * Gibt Statistiken zurück
   */
  getStats(): { callCount: number; lastPrompt: string } {
    return { callCount: this.callCount, lastPrompt: this.lastPrompt };
  }

  /**
   * Setzt Statistiken zurück
   */
  resetStats(): void {
    this.callCount = 0;
    this.lastPrompt = "";
  }
}

/**
 * Mock Timer für Tests
 * Erlaubt Kontrolle über Zeit in Tests
 */
export class MockTimer {
  private time: number = 0;
  private timers: { callback: () => void; delay: number; startTime: number }[] = [];
  private interval: NodeJS.Timeout | null = null;

  constructor() {
    this.start();
  }

  /**
   * Startet den Mock-Timer
   */
  start(): void {
    if (this.interval) return;

    this.interval = setInterval(() => {
      this.time += 100; // 100ms Schritte
      this.checkTimers();
    }, 10);
  }

  /**
   * Stoppt den Mock-Timer
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Setzt die aktuelle Zeit
   */
  setTime(ms: number): void {
    this.time = ms;
    this.checkTimers();
  }

  /**
   * Fügt Zeit hinzu
   */
  advanceTime(ms: number): void {
    this.time += ms;
    this.checkTimers();
  }

  /**
   * Gibt aktuelle Zeit zurück (Mock)
   */
  now(): number {
    return this.time;
  }

  /**
   * Gibt aktuelle Zeit zurück (Date.now() Überschreibung)
   */
  DateNow(): number {
    return this.time;
  }

  /**
   * Erstellt einen setTimeout-Mock
   */
  setTimeout(callback: () => void, delay: number): NodeJS.Timeout {
    const timerId = Symbol("timerId");
    this.timers.push({
      callback,
      delay,
      startTime: this.time
    });
    
    // Führe Callback sofort aus, wenn delay <= 0
    if (delay <= 0) {
      callback();
    }
    
    return timerId as unknown as NodeJS.Timeout;
  }

  /**
   * Erstellt einen setInterval-Mock
   */
  setInterval(callback: () => void, delay: number): NodeJS.Timeout {
    return this.setTimeout(() => {
      callback();
      this.setInterval(callback, delay);
    }, delay);
  }

  /**
   * Löscht einen Timer-Mock
   */
  clearTimeout(timerId: NodeJS.Timeout): void {
    // In Mock nicht implementiert
  }

  /**
   * Löscht einen Interval-Mock
   */
  clearInterval(timerId: NodeJS.Timeout): void {
    // In Mock nicht implementiert
  }

  /**
   * Prüft und führt abgelaufene Timer aus
   */
  private checkTimers(): void {
    const now = this.time;
    const completed: number[] = [];

    for (let i = 0; i < this.timers.length; i++) {
      const timer = this.timers[i];
      if (now >= timer.startTime + timer.delay) {
        timer.callback();
        completed.push(i);
      }
    }

    // Entferne ausgeführte Timer (von hinten nach vorne, um Index-Probleme zu vermeiden)
    for (let i = completed.length - 1; i >= 0; i--) {
      this.timers.splice(completed[i], 1);
    }
  }

  /**
   * Gibt Anzahl der aktiven Timer zurück
   */
  getTimerCount(): number {
    return this.timers.length;
  }

  /**
   * Setzt alle Timer zurück
   */
  clearAllTimers(): void {
    this.timers = [];
  }
}

/**
 * Mock Space für Unit-Tests
 * Simuliert Space-Operationen ohne echte Storage
 */
export class MockSpace {
  private entries: Map<string, any[]> = new Map();
  private entryIdCounter: number = 0;

  /**
   * Fügt eine Entry hinzu
   */
  async write(entry: any): Promise<any> {
    const type = entry.type;
    if (!this.entries.has(type)) {
      this.entries.set(type, []);
    }
    
    const entries = this.entries.get(type)!;
    const newEntry = {
      ...entry,
      id: `mock-${type.toLowerCase()}-${this.entryIdCounter++}`
    };
    entries.push(newEntry);
    
    return newEntry;
  }

  /**
   * Liest Entries
   */
  async read(template: any): Promise<any | null> {
    const type = template.type;
    const entries = this.entries.get(type) || [];
    
    if (entries.length === 0) {
      return null;
    }
    
    // Einfaches Template-Matching
    for (const entry of entries) {
      let matches = true;
      
      for (const [key, value] of Object.entries(template.fields || {})) {
        if (entry.fields[key] !== value) {
          matches = false;
          break;
        }
      }
      
      if (matches) {
        return entry;
      }
    }
    
    return entries[0]; // Return first if no specific template
  }

  /**
   * Liest alle Entries
   */
  async readAll(template: any): Promise<any[]> {
    const type = template.type;
    const entries = this.entries.get(type) || [];
    
    // Filter nach Template
    const result: any[] = [];
    for (const entry of entries) {
      let matches = true;
      
      for (const [key, value] of Object.entries(template.fields || {})) {
        if (entry.fields[key] !== value) {
          matches = false;
          break;
        }
      }
      
      if (matches) {
        result.push(entry);
      }
    }
    
    return result;
  }

  /**
   * Nimmt und entfernt eine Entry
   */
  async take(template: any): Promise<any | null> {
    const entry = await this.read(template);
    if (!entry) return null;
    
    const type = template.type;
    const entries = this.entries.get(type) || [];
    const index = entries.findIndex(e => e.id === entry.id);
    
    if (index !== -1) {
      entries.splice(index, 1);
    }
    
    return entry;
  }

  /**
   * Zählt Entries
   */
  async count(template: any): Promise<number> {
    const type = template.type;
    const entries = this.entries.get(type) || [];
    
    // Filter nach Template
    let count = 0;
    for (const entry of entries) {
      let matches = true;
      
      for (const [key, value] of Object.entries(template.fields || {})) {
        if (entry.fields[key] !== value) {
          matches = false;
          break;
        }
      }
      
      if (matches) {
        count++;
      }
    }
    
    return count;
  }

  /**
   * Löscht alle Entries
   */
  async clear(): Promise<void> {
    this.entries.clear();
    this.entryIdCounter = 0;
  }

  /**
   * Gibt Statistiken zurück
   */
  async stats(): Promise<{ [type: string]: number }> {
    const stats: { [type: string]: number } = {};
    for (const [type, entries] of this.entries) {
      stats[type] = entries.length;
    }
    return stats;
  }

  /**
   * Gibt alle Entries zurück
   */
  getAllEntries(): Map<string, any[]> {
    return new Map(this.entries);
  }
}

/**
 * Faux-Provider für Tests
 * Erstellt deterministische Faux-Antworten
 */
export function createTestFauxProvider(responses: any[] = []): any {
  const faux = fauxProvider();
  
  // Setze Standard-Antworten
  if (responses.length === 0) {
    responses = [
      fauxAssistantMessage(fauxToolCall("space_write", { 
        type: "Test", 
        fields: {} 
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"),
      fauxAssistantMessage(fauxToolCall("space_take", { 
        type: "Test" 
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("took it")
    ];
  }
  
  faux.setResponses(responses);
  return faux;
}

/**
 * Erstellt einen Mock für arXiv-Suche
 */
export function createArxivSearchMock(papers: any[] = []): any {
  return {
    arxiv_search: async (args: any) => {
      return papers;
    }
  };
}

/**
 * Erstellt einen Mock für LLM
 */
export function createLLMMock(responses: any[] = []): any {
  let callCount = 0;
  
  return {
    complete: async (prompt: string, options: any = {}) => {
      const response = responses[callCount % responses.length];
      callCount++;
      return response;
    },
    getCallCount: () => callCount,
    reset: () => { callCount = 0; }
  };
}

/**
 * Mock für Console-Output
 * Fängt console.log, console.error, etc. für Tests
 */
export class MockConsole {
  private logs: string[] = [];
  private errors: string[] = [];
  private warns: string[] = [];
  private originalLog: any;
  private originalError: any;
  private originalWarn: any;

  constructor() {
    this.originalLog = console.log;
    this.originalError = console.error;
    this.originalWarn = console.warn;
  }

  /**
   * Startet das Mocking
   */
  start(): void {
    console.log = (...args: any[]) => {
      this.logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    };
    console.error = (...args: any[]) => {
      this.errors.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    };
    console.warn = (...args: any[]) => {
      this.warns.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    };
  }

  /**
   * Stoppt das Mocking und stellt Original wieder her
   */
  stop(): void {
    console.log = this.originalLog;
    console.error = this.originalError;
    console.warn = this.originalWarn;
  }

  /**
   * Gibt Logs zurück
   */
  getLogs(): string[] {
    return [...this.logs];
  }

  /**
   * Gibt Errors zurück
   */
  getErrors(): string[] {
    return [...this.errors];
  }

  /**
   * Gibt Warnings zurück
   */
  getWarnings(): string[] {
    return [...this.warns];
  }

  /**
   * Prüft, ob eine bestimmte Nachricht geloggt wurde
   */
  hasLog(message: string | RegExp): boolean {
    const pattern = typeof message === 'string' ? new RegExp(message) : message;
    return this.logs.some(log => pattern.test(log));
  }

  /**
   * Prüft, ob ein bestimmter Error geloggt wurde
   */
  hasError(message: string | RegExp): boolean {
    const pattern = typeof message === 'string' ? new RegExp(message) : message;
    return this.errors.some(error => pattern.test(error));
  }

  /**
   * Prüft, ob eine bestimmte Warning geloggt wurde
   */
  hasWarning(message: string | RegExp): boolean {
    const pattern = typeof message === 'string' ? new RegExp(message) : message;
    return this.warns.some(warn => pattern.test(warn));
  }

  /**
   * Löscht alle Logs
   */
  clear(): void {
    this.logs = [];
    this.errors = [];
    this.warns = [];
  }
}
