#!/usr/bin/python3
"""Validate and extract a source ZIP into a new isolated staging directory."""
import hashlib,json,pathlib,stat,sys,unicodedata,zipfile
MAX_TOTAL=250*1024*1024
MAX_FILE=50*1024*1024
MAX_ENTRIES=10000
SKIP={'__MACOSX','node_modules','build','submissions'}
def main():
 archive,destination=sys.argv[1:3]
 root=pathlib.Path(destination);root.mkdir(mode=0o700,parents=True,exist_ok=False)
 files=[];seen={};spellings={};total=0;ignored=0
 with zipfile.ZipFile(archive) as z:
  entries=z.infolist()
  if len(entries)>MAX_ENTRIES:raise ValueError('ZIP 文件条目过多（最多 10000 项）。')
  checked=[]
  for item in entries:
   name=item.orig_filename
   if not name or '\x00' in name or '\\' in name or name.startswith('/'):raise ValueError('ZIP 包含无效或越界路径。')
   parts=name.rstrip('/').split('/')
   if any(p in ('','.','..') or ':' in p or any(ord(c)<32 for c in p) for p in parts):raise ValueError('ZIP 包含无效或越界路径。')
   mode=item.external_attr>>16;kind=stat.S_IFMT(mode)
   if stat.S_ISLNK(mode) or kind not in (0,stat.S_IFREG,stat.S_IFDIR):raise ValueError('ZIP 不支持符号链接或特殊文件。')
   if item.flag_bits&1:raise ValueError('请先解密 ZIP 后再上传。')
   if item.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED):raise ValueError('请使用普通 ZIP/Deflate 压缩格式。')
   total+=item.file_size
   if item.file_size>MAX_FILE or total>MAX_TOTAL:raise ValueError('ZIP 解压后超过限制（单文件 50 MB，总计 250 MB）。')
   key='/'.join(unicodedata.normalize('NFC',p).casefold() for p in parts)
   for i in range(1,len(parts)+1):
    folded='/'.join(key.split('/')[:i]);original='/'.join(parts[:i])
    if folded in spellings and spellings[folded]!=original:raise ValueError('ZIP 路径存在大小写或 Unicode 冲突。')
    spellings[folded]=original
   if key in seen:raise ValueError('ZIP 含重复文件名或大小写冲突。')
   for i in range(1,len(parts)):
    if seen.get('/'.join(key.split('/')[:i]))=='file':raise ValueError('ZIP 文件与文件夹路径冲突。')
   if not item.is_dir() and any(k.startswith(key+'/') for k in seen):raise ValueError('ZIP 文件与文件夹路径冲突。')
   seen[key]='dir' if item.is_dir() else 'file'
   if any(p.startswith('.') or p in SKIP for p in parts):ignored+=1;continue
   checked.append((item,parts))
  for item,parts in checked:
   target=root.joinpath(*parts)
   if item.is_dir():target.mkdir(parents=True,exist_ok=True);continue
   target.parent.mkdir(parents=True,exist_ok=True);digest=hashlib.sha256();size=0
   with z.open(item) as src,open(target,'xb') as out:
    while True:
     chunk=src.read(1024*1024)
     if not chunk:break
     size+=len(chunk)
     if size>item.file_size or size>MAX_FILE:raise ValueError('ZIP 文件大小异常。')
     digest.update(chunk);out.write(chunk)
   if size!=item.file_size:raise ValueError('ZIP 文件大小校验失败。')
   files.append({'path':'/'.join(parts),'size':size,'sha256':digest.hexdigest()})
 current=root
 while True:
  children=list(current.iterdir())
  if len(children)==1 and children[0].is_dir():current=children[0]
  else:break
 prefix=current.relative_to(root).as_posix()
 if prefix=='.':prefix=''
 for f in files:
  if prefix:f['path']=f['path'][len(prefix)+1:]
 print(json.dumps({'root':prefix,'files':files,'ignored':ignored},ensure_ascii=False))
if __name__=='__main__':
 try:main()
 except (ValueError,zipfile.BadZipFile,RuntimeError,NotImplementedError,EOFError) as error:
  print('ZIP 文件损坏或格式不正确，请重新打包。' if isinstance(error,zipfile.BadZipFile) else str(error),file=sys.stderr);sys.exit(2)
