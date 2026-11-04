#!/usr/bin/python3
"""EchoPaper's macOS Keychain bridge. Never put a key in argv or source files."""
import ctypes as C
import getpass
import hashlib
from pathlib import Path
import sys

if len(sys.argv)!=4 or sys.argv[1] not in ('write','read') or not __import__('re').fullmatch(r'[A-Za-z0-9._-]{1,100}',sys.argv[2]):
    raise SystemExit('Usage: provider-keychain.py read|write PROVIDER_ID BASE_URL (write reads stdin; never pass a key as an argument)')

if sys.platform != 'darwin':
    raise SystemExit('macOS Keychain is required.')
cf = C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
sec = C.CDLL('/System/Library/Frameworks/Security.framework/Security')
P = C.c_void_p
cf.CFStringCreateWithCString.argtypes=[P,C.c_char_p,C.c_uint32]; cf.CFStringCreateWithCString.restype=P
cf.CFDataCreate.argtypes=[P,P,C.c_long]; cf.CFDataCreate.restype=P
cf.CFDictionaryCreateMutable.argtypes=[P,C.c_long,P,P]; cf.CFDictionaryCreateMutable.restype=P
cf.CFDictionarySetValue.argtypes=[P,P,P]
cf.CFDataGetLength.argtypes=[P];cf.CFDataGetLength.restype=C.c_long
cf.CFDataGetBytePtr.argtypes=[P];cf.CFDataGetBytePtr.restype=P
sec.SecItemAdd.argtypes=[P,P];sec.SecItemAdd.restype=C.c_int32
sec.SecItemUpdate.argtypes=[P,P];sec.SecItemUpdate.restype=C.c_int32
sec.SecItemCopyMatching.argtypes=[P,C.POINTER(P)];sec.SecItemCopyMatching.restype=C.c_int32

def symbol(lib, name): return P.in_dll(lib,name)
def string(value): return cf.CFStringCreateWithCString(None,value.encode(),0x08000100)
def dictionary():
    return cf.CFDictionaryCreateMutable(None,0,C.addressof(C.c_byte.in_dll(cf,'kCFTypeDictionaryKeyCallBacks')),C.addressof(C.c_byte.in_dll(cf,'kCFTypeDictionaryValueCallBacks')))
def put(d,key,value): cf.CFDictionarySetValue(d,symbol(sec,key),value)
root=str(Path(__file__).resolve().parents[2])
account=hashlib.sha256(root.encode()).hexdigest()[:20]
query=dictionary()
put(query,'kSecClass',symbol(sec,'kSecClassGenericPassword'))
provider,url=sys.argv[2:4]
service='local.echopaper.minimax' if provider=='minimax' and url=='https://api.minimax.cn/v1' else 'local.echopaper.provider.'+provider+'.'+hashlib.sha256(url.encode()).hexdigest()[:20]
put(query,'kSecAttrService',string(service))
put(query,'kSecAttrAccount',string(account))
if sys.argv[1]=='write':
    key=sys.stdin.buffer.read(16385).decode('utf-8').strip()
    if not key or len(key)>8192 or any(ord(c)<32 for c in key):raise SystemExit('Invalid credential.')
    raw=key.encode();data=cf.CFDataCreate(None,raw,len(raw));updates=dictionary();put(updates,'kSecValueData',data)
    status=sec.SecItemUpdate(query,updates)
    if status==-25300:
        put(query,'kSecValueData',data);put(query,'kSecAttrLabel',string('EchoPaper · '+provider))
        status=sec.SecItemAdd(query,None)
    if status: raise SystemExit('Keychain write failed: '+str(status))
    print('Saved to macOS Keychain; no plaintext configuration written.')
else:
    put(query,'kSecReturnData',symbol(cf,'kCFBooleanTrue'))
    result=P();status=sec.SecItemCopyMatching(query,C.byref(result))
    if status: raise SystemExit('Keychain read unavailable: '+str(status))
    sys.stdout.buffer.write(C.string_at(cf.CFDataGetBytePtr(result),cf.CFDataGetLength(result)))
