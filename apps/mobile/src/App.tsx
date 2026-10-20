import React,{useEffect,useState} from 'react';
import {ChatTab} from './components/ChatTab';
import {Workbench} from './components/Atelier/Workbench';
import {DiaryLibrary} from './components/Diary/DiaryLibrary';
import {StudyRoom} from './components/Study/StudyRoom';
import {SettingsPage} from './components/SettingsPage';
import {MusicProvider} from './contexts/MusicContext';
import {fetchMembers} from './utils/apiClient';
import {updateCharacters} from './data/characters';
import {getStoredAssets,saveStoredAssets} from './utils/assetManager';
import {AssetUploadModal} from './components/AssetUploadModal';
export default function App(){
 const [page,setPage]=useState('chat'),[assets,setAssets]=useState(getStoredAssets),[assetOpen,setAssetOpen]=useState(false);
 useEffect(()=>{fetchMembers().then(updateCharacters).catch(()=>{});},[]);
 const back=()=>setPage('chat');
 return <MusicProvider><div style={{height:'100dvh',display:'flex',flexDirection:'column',background:'#fff'}}>
 <nav aria-label="导航" style={{display:'flex',gap:8,padding:8,borderBottom:'1px solid #ddd',flexWrap:'wrap'}}>
 <b>Luma</b>{[['chat','聊天'],['atelier','工作台'],['diary','日记'],['study','书房'],['settings','设置']].map(([id,label])=><button key={id} onClick={()=>setPage(id)} aria-pressed={page===id}>{label}</button>)}</nav>
 <main style={{position:'relative',flex:1,minHeight:0,overflow:'auto'}}>
 {page==='chat'&&<ChatTab onBackToHome={back} customChatBgUrl={null} initialTab="messages"/>}
 {page==='atelier'&&<Workbench onBack={back}/>}
 {page==='diary'&&<DiaryLibrary onBackToHome={back}/>}
 {page==='study'&&<StudyRoom onBackToHome={back}/>}
 {page==='settings'&&<SettingsPage isNight={false} onToggleNight={()=>{}} onReplaySplash={back} onBackToHome={back} assets={assets} onOpenAssetModal={()=>setAssetOpen(true)}/>}
 </main>{assetOpen&&<AssetUploadModal isOpen={assetOpen} assets={assets} onClose={()=>setAssetOpen(false)} onUpdateAssets={next=>{setAssets(next);saveStoredAssets(next);}}/>}</div></MusicProvider>;
}
