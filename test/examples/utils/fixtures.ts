// Test-Fixtures für pi-spaces Beispiele
// Bereitstellung von Test-Daten und Mock-Implementierungen

import { FOREVER } from "../../../src/index.ts";
import type { EntryDraft } from "../../../src/index.ts";

/**
 * Fixtures für workers.ts Tests
 */
export const workersFixtures = {
  // Einfache Job-Entries
  simpleJob: (op: string = "test", file: string = "test.txt") => ({
    type: "Job",
    fields: { op, file },
  }),
  
  // Mehrere Jobs
  multipleJobs: (count: number = 10) => {
    const jobs  : EntryDraft[] = [];
    for (let i = 0; i < count; i++) {
      jobs.push({
        type: "Job",
        fields: { op: `op-${i}`, file: `file-${i}.txt` },
      });
    }
    return jobs;
  },
  
  // Job-Template
  jobTemplate: { type: "Job" }
};

/**
 * Fixtures für blocking-tool.ts Tests
 */
export const blockingToolFixtures = {
  // Job mit Timeout
  jobWithTimeout: (timeoutMs: number = 5000) => ({
    type: "Job",
    fields: { op: "test", timeoutMs },
  }),
  
  // Template für Timeout-Jobs
  jobTemplate: { type: "Job" }
};

/**
 * Fixtures für chat.ts Tests
 */
export const chatFixtures = {
  // Standard-Nachricht
  simpleMessage: (from: string = "alice", to: string = "bob", n: number = 1, text: string = "Hallo") => ({
    type: "Msg",
    fields: { room: "lobby", from, to, n, text },
  }),
  
  // Startnachricht vom Host
  hostMessage: (topic: string = "Test Thema") => ({
    type: "Msg",
    fields: { room: "lobby", from: "host", to: "alice", n: 0, text: topic },
  }),
  
  // Ring-Nachrichten
  ringMessages: (names: string[] = ["alice", "bob", "carol"], turns: number = 3) => {
    const messages  : EntryDraft[] = [];
    
    // Startnachricht
    messages.push(chatFixtures.hostMessage());
    
    // Ring-Nachrichten
    for (let i = 1; i <= turns; i++) {
      const from = names[(i - 1) % names.length];
      const to = names[i % names.length];
      messages.push(chatFixtures.simpleMessage(from, to, i, `Nachricht ${i}`));
    }
    
    return messages;
  },
  
  // Nachricht-Template
  messageTemplate: { type: "Msg", fields: { room: "lobby" } },
  
  // Template für Nachrichten an bestimmten Empfänger
  messageToTemplate: (to: string) => ({ type: "Msg", fields: { to } })
};

/**
 * Fixtures für sensor-pipeline.ts Tests
 */
export const sensorPipelineFixtures = {
  // Fenster
  window: (id: string = "w1", sources: string[] = ["station", "forecast", "cloud"]) => ({
    type: "Window",
    fields: { id, sources },
  }),
  
  // Sensor-Daten
  reading: (source: string, window: string, ts: number, kind: string, value: number) => ({
    type: "Reading",
    fields: { source, window, ts, kind, value },
  }),
  
  // Fertig-Meldung
  done: (source: string, window: string) => ({
    type: "Done",
    fields: { source, window },
  }),
  
  // Zusammenfassung
  summary: (window: string, stats: any, missing: string[] = [], duplicates: number = 0, rejected: number = 0) => ({
    type: "Summary",
    fields: { window, stats, missing, duplicates, rejected },
  }),
  
  // Bericht
  report: (window: string, text: string) => ({
    type: "Report",
    fields: { window, text },
  }),
  
  // Sample-Daten
  sampleData: [
    { ts: 0, kind: "temp", value: 10.5 },
    { ts: 5 * 60 * 1000, kind: "temp", value: 11.2 },
    { ts: 10 * 60 * 1000, kind: "temp", value: 9.8 },
    { ts: 0, kind: "cloud", value: 20 },
    { ts: 5 * 60 * 1000, kind: "cloud", value: 25 },
  ],
  
  // Template für Fenster
  windowTemplate: { type: "Window" },
  
  // Template für Readings
  readingTemplate: { type: "Reading" }
};

/**
 * Fixtures für golomb.ts Tests
 */
export const golombFixtures = {
  // Suchaufgabe
  searchTask: (order: number = 12, taskId: string = "test-1", startPos: number = 0, endPos: number = 100) => ({
    type: "GolombSearchTask",
    fields: {
      taskId,
      order,
      minLength: order * (order - 1) / 2,
      maxLength: order * (order - 1) / 2 * 2,
      startPos,
      endPos,
      status: "pending"
    },
  }),
  
  // Gefundenes Lineal
  foundRuler: (order: number = 12, length: number = 91, positions: number[] = [0, 1, 4, 10, 20, 35, 55, 65, 75, 85, 90, 91]) => ({
    type: "GolombRuler",
    fields: {
      order,
      length,
      positions,
      distances: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91],
      missingDistances: [],
      isOptimal: true,
      foundAt: new Date().toISOString(),
      workerId: "worker-1"
    },
  }),
  
  // Beste bekannte Lösung
  bestKnown: (order: number = 12, length: number = 91, positions: number[] = [0, 1, 4, 10, 20, 35, 55, 65, 75, 85, 90, 91]) => ({
    type: "GolombBestKnown",
    fields: {
      order,
      length,
      positions,
      source: "LUT",
      updatedAt: new Date().toISOString()
    },
  }),
  
  // Suchfortschritt
  searchProgress: (taskId: string = "test-1", order: number = 12, currentA2: number = 50) => ({
    type: "GolombSearchProgress",
    fields: {
      taskId,
      order,
      currentLength: currentA2,
      currentMarks: [0, currentA2],
      checkedPositions: 50,
      lastUpdate: new Date().toISOString(),
      workerId: "worker-1"
    },
  }),
  
  // Zusammenfassung
  summary: (order: number = 12, totalRulers: number = 1, optimalRulers: number = 1, shortestLength: number = 91) => ({
    type: "GolombSummary",
    fields: {
      order,
      totalRulers,
      optimalRulers,
      shortestLength,
      searchCompleted: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    },
  }),
  
  // Bekannte optimale Lösungen (für Tests)
  knownOptimal: {
    2: { length: 1, positions: [0, 1] },
    3: { length: 3, positions: [0, 1, 3] },
    4: { length: 6, positions: [0, 1, 4, 6] },
    5: { length: 11, positions: [0, 1, 4, 9, 11] },
    6: { length: 17, positions: [0, 1, 4, 10, 12, 17] },
  },
  
  // Template für Suchaufgaben
  taskTemplate: { type: "GolombSearchTask" }
};

/**
 * Fixtures für arxiv-research.ts Tests
 */
export const arxivResearchFixtures = {
  // Paper-Metadaten
  paperMetadata: (arxivId: string = "2304.12345", title: string = "Test Paper") => ({
    type: "Paper",
    fields: {
      arxivId,
      title,
      year: 2023,
      authors: ["Author One", "Author Two"],
      approach: "Transformer",
      contribution: "New architecture",
      collector: "collector-1"
    },
  }),
  
  // Nachricht
  message: (from: string, to: string, text: string) => ({
    type: "Msg",
    fields: { room: "research", from, to, text },
  }),
  
  // Fertig-Meldung vom Collector
  collectorDone: (collector: string = "collector-1", papers: number = 10) => ({
    type: "CollectorDone",
    fields: { collector, papers },
  }),
  
  // Analyse-Auftrag
  analyzeTask: (topic: string = "Test Topic") => ({
    type: "AnalyzeTask",
    fields: { topic },
  }),
  
  // Analyse-Ergebnis
  analysis: (order: number = 1, title: string = "Epoche 1") => ({
    type: "Analysis",
    fields: {
      order,
      title,
      period: "1998-2010",
      approaches: ["Attention", "Feed-forward"],
      keyPapers: ["2304.12345", "2305.67890"],
      summary: "Zusammenfassung der ersten Epoche",
      limits: "Begrenzte Rechenleistung"
    },
  }),
  
  // Präsentations-Auftrag
  presentTask: (topic: string = "Test Topic") => ({
    type: "PresentTask",
    fields: { topic },
  }),
  
  // Bericht
  report: (title: string = "Forschungsbericht", markdown: string = "# Bericht\n\nInhalt") => ({
    type: "Report",
    fields: { title, markdown },
  }),
  
  // Template für Papers
  paperTemplate: { type: "Paper" },
  
  // Template für Analysen
  analysisTemplate: { type: "Analysis" }
};

/**
 * Fixtures für dark-energy-research.ts Tests
 */
export const darkEnergyFixtures = {
  // Paper-Metadaten (erweitert)
  paperMetadata: (arxivId: string = "2304.12345", title: string = "Dark Energy Observations") => ({
    type: "PaperMetadata",
    fields: {
      arxivId,
      title,
      year: 2023,
      authors: ["Astrophysicist One", "Astrophysicist Two"],
      abstract: "A study on dark energy...",
      categories: ["astro-ph.CO", "gr-qc"],
      published: new Date().toISOString(),
      classification: null
    },
  }),
  
  // Klassifiziertes Paper
  classifiedPaper: (paperId: string = "2304.12345") => ({
    type: "ClassifiedPaper",
    fields: {
      paperId,
      relevance: "high",
      topics: ["dark energy", "cosmological constant"],
      keywords: ["ΛCDM", "Hubble tension"],
      confidence: 0.95,
      classifiedAt: new Date().toISOString(),
      model: "mistral-7b"
    },
  }),
  
  // Paper-Zusammenfassung
  paperSummary: (paperId: string = "2304.12345") => ({
    type: "PaperSummary",
    fields: {
      paperId,
      summary: "This paper presents new observations...",
      keyFindings: ["Finding 1", "Finding 2"],
      citationCount: 42,
      relatedPapers: ["2305.67890"],
      summarizedAt: new Date().toISOString(),
      model: "llama-2-70b"
    },
  }),
  
  // Analyse-Ergebnis
  analysisResult: (analysisType: string = "timeTrends") => ({
    type: "AnalysisResult",
    fields: {
      analysisType,
      data: analysisType === "timeTrends" 
        ? { byYear: { 2020: 10, 2021: 15, 2022: 20, 2023: 25, 2024: 30 } }
        : {},
      timestamp: new Date().toISOString(),
      model: "mistral-7b"
    },
  }),
  
  // Benutzeranfrage
  userQuery: (query: string = "Was sind die neuesten Entwicklungen?") => ({
    type: "UserQuery",
    fields: {
      queryId: `query-${Date.now()}`,
      query,
      userId: "user-1",
      timestamp: new Date().toISOString()
    },
  }),
  
  // Antwort auf Benutzeranfrage
  queryResponse: (queryId: string = `query-${Date.now()}`) => ({
    type: "QueryResponse",
    fields: {
      queryId,
      response: "Antwort basierend auf den Paper-Daten...",
      sources: ["2304.12345", "2305.67890"],
      model: "mistral-7b",
      confidence: 0.9,
      timestamp: new Date().toISOString()
    },
  }),
  
  // System-Status
  systemStatus: () => ({
    type: "SystemStatus",
    fields: {
      timestamp: new Date().toISOString(),
      statistics: {
        papers: { total: 100, classified: 80, summarized: 60 },
        analyses: { total: 5 },
        queries: { received: 10, responded: 8 }
      },
      progress: {
        crawlingComplete: true,
        classificationComplete: true,
        summarizationComplete: true,
        analysisComplete: false,
        presentationComplete: false
      },
      startedAt: new Date().toISOString()
    },
  }),
  
  // Aufgabentypen
  crawlTask: (topic: string = "Dunkle Energie") => ({
    type: "CrawlTask",
    fields: {
      taskId: `crawl-${Date.now()}`,
      searchTerms: ["dark energy", "dark matter"],
      startDate: new Date("1998-01-01").toISOString(),
      endDate: new Date().toISOString(),
      maxResults: 100,
      status: "pending",
      resultsFound: 0
    },
  }),
  
  classifyTask: (topic: string = "Dunkle Energie") => ({
    type: "ClassifyTask",
    fields: { topic },
  }),
  
  summarizeTask: (topic: string = "Dunkle Energie") => ({
    type: "SummarizeTask",
    fields: { topic },
  }),
  
  analyzeTask: (topic: string = "Dunkle Energie") => ({
    type: "AnalyzeTask",
    fields: { topic },
  }),
  
  presentTask: (topic: string = "Dunkle Energie") => ({
    type: "PresentTask",
    fields: { topic },
  }),
  
  // Fertig-Meldungen
  crawlDone: () => ({
    type: "CrawlDone",
    fields: {
      crawler: "crawler-1",
      papersFound: 100,
      timestamp: new Date().toISOString()
    },
  }),
  
  classificationDone: () => ({
    type: "ClassificationDone",
    fields: {
      classifier: "classifier-1",
      timestamp: new Date().toISOString()
    },
  }),
  
  summarizationDone: () => ({
    type: "SummarizationDone",
    fields: {
      summarizer: "summarizer-1",
      papersSummarized: 60,
      timestamp: new Date().toISOString()
    },
  })
};

/**
 * Mock-Daten für Tests
 */
export const mockData = {
  // Mock arXiv API Antwort
  mockArxivResponse: {
    feed: {
      entry: [
        {
          id: "http://arxiv.org/abs/2304.12345",
          title: { type: "text", content: "Test Paper 1" },
          author: [
            { name: { content: "Author One" } },
            { name: { content: "Author Two" } }
          ],
          summary: { type: "text", content: "Abstract of test paper 1" },
          published: { type: "text", content: "2023-04-01T00:00:00Z" },
          arXiv: {
            primary_category: { term: "cs.LG", label: "Machine Learning" }
          }
        },
        {
          id: "http://arxiv.org/abs/2305.67890",
          title: { type: "text", content: "Test Paper 2" },
          author: [{ name: { content: "Author Three" } }],
          summary: { type: "text", content: "Abstract of test paper 2" },
          published: { type: "text", content: "2023-05-01T00:00:00Z" },
          arXiv: {
            primary_category: { term: "cs.AI", label: "Artificial Intelligence" }
          }
        }
      ]
    }
  },
  
  // Mock LLM Antwort für Klassifikation
  mockClassificationResponse: {
    relevance: "high",
    topics: ["machine learning", "transformers"],
    keywords: ["attention", "neural networks"],
    confidence: 0.98
  },
  
  // Mock LLM Antwort für Zusammenfassung
  mockSummaryResponse: {
    summary: "This paper introduces a new transformer architecture...",
    keyFindings: [
      "New architecture with improved performance",
      "Reduced training time by 30%",
      "Better generalization"
    ],
    citationCount: 42
  }
};

/**
 * Fixture-Funktionen zum Erstellen von Test-Daten in Bulk
 */
export const fixtureFactory = {
  /**
   * Erstellt N Job-Entries
   */
  createJobs: (count: number, prefix: string = "job") => {
    return workersFixtures.multipleJobs(count).map((job, i) => ({
      ...job,
      fields: { ...job.fields, op: `${prefix}-${i}`, file: `${prefix}-${i}.txt` }
    }));
  },
  
  /**
   * Erstellt N Fenster mit zugehörigen Readings und Done-Meldungen
   */
  createWindowsWithData: (windowCount: number, readingsPerWindow: number = 3) => {
    const allEntries  : EntryDraft[] = [];
    
    for (let w = 0; w < windowCount; w++) {
      const window = sensorPipelineFixtures.window(`w${w}`, ["station", "forecast", "cloud"]);
      allEntries.push(window);
      
      for (let r = 0; r < readingsPerWindow; r++) {
        const source = ["station", "forecast", "cloud"][r % 3];
        const reading = sensorPipelineFixtures.reading(
          source, `w${w}`, r * 5 * 60 * 1000, 
          r % 2 === 0 ? "temp" : "cloud",
          10 + r * 2
        );
        allEntries.push(reading);
      }
      
      // Done-Meldungen
      for (const source of ["station", "forecast", "cloud"]) {
        const done = sensorPipelineFixtures.done(source, `w${w}`);
        allEntries.push(done);
      }
    }
    
    return allEntries;
  },
  
  /**
   * Erstellt N Golomb-Suchaufgaben
   */
  createGolombTasks: (count: number, order: number = 12) => {
    const tasks  : EntryDraft[] = [];
    const chunkSize = Math.ceil(100 / count);
    
    for (let i = 0; i < count; i++) {
      const startPos = i * chunkSize;
      const endPos = Math.min((i + 1) * chunkSize, 100);
      const task = golombFixtures.searchTask(order, `task-${i}`, startPos, endPos);
      tasks.push(task);
    }
    
    return tasks;
  },
  
  /**
   * Erstellt N Paper-Metadaten
   */
  createPapers: (count: number, yearStart: number = 2020) => {
    const papers  : EntryDraft[] = [];
    
    for (let i = 0; i < count; i++) {
      const paper = arxivResearchFixtures.paperMetadata(
        `${yearStart + (i % 5)}.${10000 + i}`,
        `Paper Title ${i}`
      );
      papers.push(paper);
    }
    
    return papers;
  }
};
