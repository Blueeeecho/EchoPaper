/** Local single-selection policy, independent of any provider's model context window. */
export const MAX_TRANSLATION_SELECTION = 6000;
/** Count Unicode code points consistently on both sides; astral symbols count once. */
export const translationCharacterCount = (text: string): number => Array.from(text).length;
export const translationLengthMessage = (count: number): string => `选区过长：已选 ${count} 个字符，单次翻译上限为 ${MAX_TRANSLATION_SELECTION} 个字符。请缩小选区。`;
