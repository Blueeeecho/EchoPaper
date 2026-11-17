// A selection in the notes or toolbar must not replace the source excerpt.
// No ranges means the browser explicitly cleared the source selection.
export function readingSelectionText(selection: Selection|null, source: Pick<Element,'contains'>|null): string|undefined {
 if(!selection||!selection.rangeCount)return '';
 if(!source?.contains(selection.anchorNode)||!source.contains(selection.focusNode))return undefined;
 return selection.toString().trim().slice(0,6000);
}
