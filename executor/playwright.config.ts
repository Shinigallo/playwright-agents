/**
 * ============================================================
 * Playwright Configuration — Executor
 * ============================================================
 * Configurazione di Playwright per l'Executor container.
 * Questa configurazione è ottimizzata per l'esecuzione headless
 * in ambiente Docker, con focus su:
 *   - Anti-bot detection evasion
 *   - Massima raccolta di artefatti (screenshot, video, trace)
 *   - Compatibilità con siti che usano lazy loading e animazioni
 * ============================================================
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  /**
   * Directory dei test. I .spec.ts vengono scritti qui dall'Executor
   * prima di essere eseguiti. DEVE coincidere con LOCAL_TEST_DIR in index.ts.
   * Playwright rifiuta di eseguire file fuori da testDir.
   */
  testDir: './tests',

  /**
   * Timeout massimo per test: 90 secondi.
   * Sufficiente per la maggior parte dei siti web. Siti con navigazione
   * lenta o molti redirect potrebbero richiedere valori più alti.
   */
  timeout: 90000,

  use: {
    /** Esecuzione headless: nessun browser visibile (necessario in Docker) */
    headless: true,

    /** Risoluzione standard del browser headless */
    viewport: { width: 1280, height: 720 },

    /**
     * Ignora errori di certificato HTTPS.
     * Utile per ambienti di staging/test con certificati self-signed.
     */
    ignoreHTTPSErrors: true,

    /**
     * Cattura screenshot per OGNI test (passato o fallito).
     * 'on' invece di 'on-first-retry' garantisce screenshot navigabili
     * in tutti i report HTML, non solo per i fallimenti.
     */
    screenshot: 'on',

    /**
     * Registra video per OGNI test.
     * 'on' invece di 'retain-on-failure' perché vogliamo il replay
     * anche per i test passati, utile per verifica visiva.
     */
    video: 'on',

    /**
     * Raccoglie il trace per OGNI test.
     * Il trace include: timeline delle azioni, snapshot DOM, network,
     * screenshot step-by-step. Visibile nel Trace Viewer (porte 9300-9320).
     */
    trace: 'on',

    /**
     * User Agent realistico per evitare il rilevamento anti-bot.
     * Molti siti bloccano richieste con User-Agent di automazione/headless.
     * Questo UA simula Chrome 124 su Windows — il più comune in produzione.
     */
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

    /**
     * Header HTTP aggiuntivi per comportarsi come un browser reale.
     * Accept-Language: preferenza italiana (utile per siti .it)
     * Accept: lista completa di content type accettati
     */
    extraHTTPHeaders: {
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },

    launchOptions: {
      args: [
        '--no-sandbox',             // necessario per root in Docker (container gira come root)
        '--disable-setuid-sandbox', // richiesto insieme a --no-sandbox
        /**
         * Disabilita il flag che rivela Chromium come browser automatizzato.
         * Senza questo, navigator.webdriver === true e molti anti-bot lo rilevano.
         */
        '--disable-blink-features=AutomationControlled',
        /**
         * Usa /tmp invece di /dev/shm per la shared memory.
         * In Docker, /dev/shm è spesso limitato a 64MB causando crash
         * su pagine con molto JavaScript.
         */
        '--disable-dev-shm-usage',
      ],
    },
  },

  /**
   * Reporter configurati per ogni run:
   * - json: output strutturato in PLAYWRIGHT_JSON_OUTPUT_NAME (per l'API /execute)
   * - html: report interattivo in PLAYWRIGHT_HTML_REPORT (per il Trace Viewer)
   * open: 'never' evita che Playwright tenti di aprire il browser dopo il test
   */
  reporter: [['json'], ['html', { open: 'never' }]],
});
