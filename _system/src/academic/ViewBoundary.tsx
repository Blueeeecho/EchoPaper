import {Component,type ReactNode} from 'react';

interface Props {
 children:ReactNode;
 fallback:ReactNode;
 viewKey?:string;
}

interface State {
 failed:boolean;
 viewKey?:string;
}

export default class ViewBoundary extends Component<Props,State> {
 state:State={failed:false,viewKey:this.props.viewKey};

 static getDerivedStateFromError(){return {failed:true};}

 static getDerivedStateFromProps({viewKey}:Props,state:State){
  return viewKey===state.viewKey?null:{failed:false,viewKey};
 }

 render(){
  return this.state.failed?this.props.fallback:this.props.children;
 }
}
