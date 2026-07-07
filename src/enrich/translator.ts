export interface TranslationResult {
  text: string;
  confidence: number;
}

export interface Translator {
  readonly id: string;
  /**
   * True when this translator can only ever produce empty output (a no-op stub
   * with no real backend). Curate skips the translate stage entirely for such a
   * translator rather than looping the catalog writing empty rows (spec 051 FR-332).
   */
  readonly noop?: boolean;
  translate(text: string, source: 'bg', target: 'en'): Promise<TranslationResult>;
}
