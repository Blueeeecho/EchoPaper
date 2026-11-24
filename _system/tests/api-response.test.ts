import test from 'node:test';
import assert from 'node:assert/strict';
import {api,ApiError} from '../src/api';

test('a successful HTML or truncated JSON response reports a read failure without poisoning page state',async context=>{
 const fetch=context.mock.method(globalThis,'fetch',async()=>new Response('<!doctype html><title>EchoPaper</title>'));
 await assert.rejects(api('/api/projects'),(error:unknown)=>error instanceof ApiError&&error.status===502);
 fetch.mock.mockImplementation(async()=>new Response('{"projects":'));
 await assert.rejects(api('/api/projects'),(error:unknown)=>error instanceof ApiError&&error.status===502);
 fetch.mock.mockImplementation(async()=>new Response(null,{status:204}));
 assert.deepEqual(await api('/api/projects'),{});
 fetch.mock.mockImplementation(async()=>new Response('{"error":"版本冲突","current":{"hash":"new"}}',{status:409}));
 await assert.rejects(api('/api/projects'),(error:unknown)=>error instanceof ApiError&&error.status===409&&error.data.current.hash==='new');
});

