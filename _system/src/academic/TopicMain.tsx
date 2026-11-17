import {useCallback,useState} from 'react';
import type {ResearchTopic,Resource,WorkspaceOverview} from '../../shared/workspace-types';
import TopicLiterature from './TopicLiterature';
import type {PdfImporter} from './PdfImport';
import TopicNotes,{type TopicPaperRequest} from './TopicNotes';
import {useTopicNotebook} from './useTopicNotebook';

/** Independent topic notes and the papers used to develop them. */
export default function TopicMain({topic,overview,onRefresh,onError,onGuardChange,importer}:{topic:ResearchTopic;overview?:WorkspaceOverview;onRefresh:()=>Promise<void>;onError:(s:string)=>void;onGuardChange:(guard:(()=>Promise<boolean>)|undefined)=>void;importer:PdfImporter}){
 const {notebook,update}=useTopicNotebook(topic.id,onError);
 const [files,setFiles]=useState<Resource[]>([]),[paperRequest,setPaperRequest]=useState<TopicPaperRequest>();
 const [noteRequest,setNoteRequest]=useState<{id:string;noteId:string}>();
 const openPaper=useCallback((paper:Resource)=>setPaperRequest({id:crypto.randomUUID(),paper}),[]);
 const openNote=useCallback((note:Resource)=>setNoteRequest({id:crypto.randomUUID(),noteId:note.id}),[]);
 const starred=new Set(notebook.keyRefs.map(r=>r.resourceId));
 const toggleStar=(f:Resource)=>update(n=>n.keyRefs.some(r=>r.resourceId===f.id)?{...n,keyRefs:n.keyRefs.filter(r=>r.resourceId!==f.id)}:{...n,keyRefs:[...n.keyRefs,{resourceId:f.id,note:'',addedAt:new Date().toISOString()}]});
 return <div className="topic-main-stack">
  <TopicNotes topic={topic} files={files} paperRequest={paperRequest} noteRequest={noteRequest} legacyIdeas={notebook.ideas} onRefresh={onRefresh} onGuardChange={onGuardChange}/>
  <TopicLiterature importer={importer} topic={topic} overview={overview} onRefresh={onRefresh} onError={onError} starred={starred} onToggleStar={toggleStar} onFiles={setFiles} onOpenPaper={openPaper} onOpenTopicNote={openNote}/>
 </div>;
}
