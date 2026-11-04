import type {StylePack} from '../../shared/presentation-types';

// The gallery uses cover thumbnails, separate from the content-page style preview.
export const templateCoverUrl=(style:StylePack)=>style.coverPreviewUrl||`/presentation-covers/${encodeURIComponent(style.id)}/${encodeURIComponent(style.version)}.png`;
