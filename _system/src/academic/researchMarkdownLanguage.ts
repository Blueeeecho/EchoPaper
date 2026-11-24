import {markdown,markdownLanguage} from '@codemirror/lang-markdown';

const compactHeading=/^(#{1,6})(?=\p{Script=Han})/u;

export const researchMarkdownLanguage=markdown({
 base:markdownLanguage,
 completeHTMLTags:false,
 extensions:{
  parseBlock:[{
   name:'CompactChineseHeading',
   before:'ATXHeading',
   parse(context,line){
    const level=compactHeading.exec(line.text.slice(line.pos))?.[1].length;
    if(!level)return false;
    const from=context.lineStart+line.pos,end=context.lineStart+line.text.length;
    const mark=context.elt('HeaderMark',from,from+level);
    const content=context.parser.parseInline(line.text.slice(line.pos+level),from+level);
    context.nextLine();
    context.addElement(context.elt('ATXHeading'+level,from,end,[mark,...content]));
    return true;
   },
   endLeaf(_context,line){
    return line.indent-line.baseIndent<4&&compactHeading.test(line.text.slice(line.pos));
   },
  }],
 },
});
