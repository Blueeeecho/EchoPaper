import { Fragment, useEffect, useState } from 'react';
import type { PresentationBlock, PresentationDocument, PresentationSlide, StylePack } from '../../shared/presentation-types';

interface Props {
  document: PresentationDocument;
  slide: PresentationSlide;
  index: number;
  style?: StylePack;
  previewUrl?: string;
  savedPreviewUrl?: string;
  compact?: boolean;
}

/** Keep mixed Chinese / Latin text on the same font contract as the exported deck. */
export function PresentationText({ text = '' }: { text?: string }) {
  return <>{text.split(/([\p{Script=Han}\u3000-\u303f\uff00-\uffef]+)/u).filter(Boolean).map((part, index) =>
    <span key={index} className={/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(part) ? 'presentation-text-zh' : 'presentation-text-en'}>{part}</span>)}</>;
}

function Bilingual({ primary, english, language, className = '', verbatim = false }: { primary?: string; english?: string; language: PresentationDocument['language']; className?: string; verbatim?: boolean }) {
  const first = language === 'en' && !verbatim ? english || primary : primary || english;
  return <div className={className}><div><PresentationText text={first}/></div>{language === 'zh-en' && !verbatim && english && primary && english !== primary && <div className="presentation-translation"><PresentationText text={english}/></div>}</div>;
}

function Chart({ block }: { block: PresentationBlock }) {
  const labels = block.labels || [];
  const series = block.series || [];
  const all = series.flatMap(item => item.values).filter(Number.isFinite);
  const high = Math.max(0, ...all) || 1;
  const low = Math.min(0, ...all);
  const height = 140, range = high - low || 1;
  const y = (value: number) => 15 + (high - value) / range * height;
  const group = 430 / Math.max(labels.length, 1), width = Math.min(34, group / Math.max(series.length, 1) - 4);
  const colors = ['#17714b', '#859b7d', '#c2ad7b', '#567c8a'];
  return <div className="presentation-chart"><svg viewBox="0 0 520 200" role="img" aria-label={block.title || '数据图表'}>
    <line x1="48" x2="493" y1={y(0)} y2={y(0)} stroke="#b6b9ad"/>
    {[high, low].map((value, index) => <text key={index} x="39" y={y(value) + 3} textAnchor="end" fontSize="10" fill="#657063">{value.toLocaleString('en-US', { maximumFractionDigits: 3 })}</text>)}
    {labels.map((label, i) => <Fragment key={i}>{series.map((item, k) => {
      const value = item.values[i];
      if (!Number.isFinite(value)) return null;
      const x = 55 + i * group + k * (width + 4);
      return <g key={k}><title>{`${label} · ${item.name}: ${value}`}</title><rect x={x} y={Math.min(y(value), y(0))} width={width} height={Math.max(1, Math.abs(y(0) - y(value)))} fill={colors[k % colors.length]}/><text x={x + width / 2} y={value >= 0 ? y(value) - 4 : y(value) + 13} textAnchor="middle" fontSize="9" fill="#344d3d">{value}</text></g>;
    })}<text x={55 + i * group + Math.max(series.length, 1) * (width + 4) / 2} y="181" textAnchor="middle" fontSize="11" fill="#344d3d">{label}</text></Fragment>)}
  </svg><div className="presentation-chart-legend">{series.map((item, index) => <span key={index}><i style={{ background: colors[index % colors.length] }}/><PresentationText text={item.name}/></span>)}</div></div>;
}

function Block({ block, document }: { block: PresentationBlock; document: PresentationDocument }) {
  const source = document.sources.find(item => item.assetId === block.assetId);
  const imageUrl = block.assetId ? `/api/presentations/${encodeURIComponent(document.id)}/assets/${encodeURIComponent(block.assetId)}` : undefined;
  return <section className={`presentation-block presentation-block-${block.type}`}>
    {(block.title || block.titleEn) && <Bilingual primary={block.title} english={block.titleEn} language={document.language} className="presentation-block-title" verbatim={block.verbatim || block.type === 'case'}/>}
    {block.type === 'table' ? <div className="presentation-table-wrap"><table>{!!block.headers?.length && <thead><tr>{block.headers.map((cell, index) => <th key={index}><PresentationText text={cell}/></th>)}</tr></thead>}<tbody>{(block.rows || []).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}><PresentationText text={cell}/></td>)}</tr>)}</tbody></table>{!block.rows?.length && <p className="presentation-empty-content">表格尚未填写</p>}</div>
      : block.type === 'steps' ? <ol className="presentation-pipeline">{(block.steps || []).map((step, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span><strong><PresentationText text={step.title}/></strong>{step.text && <p><PresentationText text={step.text}/></p>}</li>)}</ol>
      : block.type === 'image' ? <figure>{imageUrl ? <img src={imageUrl} alt={block.caption || source?.name || block.title || '演示图片'}/> : <div className="presentation-empty-image">图片尚未关联素材</div>}{block.caption && <figcaption><PresentationText text={block.caption}/></figcaption>}</figure>
      : block.type === 'chart' ? <Chart block={block}/>
      : <Bilingual primary={block.text} english={block.textEn} language={document.language} className="presentation-block-text" verbatim={block.verbatim || block.type === 'case'}/>
    }
    {block.caption && block.type !== 'image' && <p className="presentation-block-caption"><PresentationText text={block.caption}/></p>}
  </section>;
}

export default function PresentationPreview({ document, slide, index, style, previewUrl, savedPreviewUrl, compact = false }: Props) {
  const candidate = previewUrl || savedPreviewUrl;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [candidate]);
  const navigation = style?.navigation?.length ? style.navigation : ['研究背景', '研究内容', '研究结果', '未来计划'];
  const logoUrl = style?.logoUrl;
  const isCover = slide.layout === 'cover' || slide.layout === 'thanks';
  return <div className={`presentation-preview ${compact ? 'is-compact' : ''}`} data-layout={slide.layout}>
    {candidate && !failed ? <img className="presentation-rendered-preview" src={candidate} alt={`第 ${index + 1} 页：${slide.title || slide.titleEn}`} onError={() => setFailed(true)}/>
      : <article className={`presentation-slide presentation-layout-${slide.layout}`} aria-label={`第 ${index + 1} 页内容预览`}>
        <header className="presentation-slide-header"><span className="presentation-hzau-mark">{logoUrl ? <img src={logoUrl} alt="华中农业大学"/> : <span className="presentation-hzau-wordmark"><span className="presentation-text-zh">华中农业大学</span><small>HUAZHONG AGRICULTURAL UNIVERSITY</small></span>}</span><nav aria-label="幻灯片章节">{navigation.map(item => <span key={item} className={item === slide.section ? 'active' : ''}><PresentationText text={item}/></span>)}</nav></header>
        <div className="presentation-slide-content"><Bilingual primary={slide.title} english={slide.titleEn} language={document.language} className="presentation-slide-title"/>
          {slide.keyMessage && <p className="presentation-key-message"><PresentationText text={slide.keyMessage}/></p>}
          <div className="presentation-slide-blocks">{slide.blocks.map(block => <Block key={block.id} block={block} document={document}/>)}</div>
          {isCover && (document.presenter || document.advisor) && <p className="presentation-cover-byline"><PresentationText text={[document.presenter && `汇报人：${document.presenter}`, document.advisor && `指导教师：${document.advisor}`].filter(Boolean).join('    ')}/></p>}
        </div><footer className="presentation-slide-footer"><span><PresentationText text={document.title}/></span><span>{index + 1} / {document.slides.length}</span></footer>
      </article>}
  </div>;
}
