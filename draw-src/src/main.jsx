import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw } from '@tldraw/tldraw';
import './style.css';

const API = '/drawings';
const ID = new URLSearchParams(location.search).get('id');
const validId = (value) => /^[0-9a-f]{32}$/.test(value);
const drawingContent = (document) => JSON.stringify([document.name, document.pages, document.assets]);
const isNew = ID === null;

const basicAuth = (username, password) => {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

function App() {
  const appRef = useRef(null);
  const initialDocument = useRef(null);
  const authRef = useRef(null);
  const revisionRef = useRef(0);
  const idRef = useRef(isNew ? null : ID);
  const dirtyRef = useRef(false);
  const savedContentRef = useRef('');
  const changeVersionRef = useRef(0);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);
  const closeRef = useRef(false);
  const shareRef = useRef(false);
  const timerRef = useRef(null);
  const [authorized, setAuthorized] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('Waiting for chat authentication…');
  const [canSave, setCanSave] = useState(false);

  const post = useCallback((message) => {
    if (window.parent !== window) window.parent.postMessage(message, location.origin);
  }, []);

  const save = useCallback(async () => {
    const app = appRef.current;
    const auth = authRef.current;
    if (!app || !auth || !loaded || savingRef.current || conflictRef.current || !dirtyRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setStatus('Saving…');
    let changedDuringSave = false;
    try {
      const changeVersion = changeVersionRef.current;
      const document = app.document;
      const savedContent = drawingContent(document);
      const blob = await app.getImage('png');
      let preview = null;
      if (blob && blob.size <= 4 * 1024 * 1024) {
        preview = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not prepare preview.'));
          reader.readAsDataURL(blob);
        });
      }
      const currentId = idRef.current;
      const response = await fetch(currentId ? `${API}/${currentId}` : API, {
        method: currentId ? 'PUT' : 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${basicAuth(auth.username, auth.password)}`,
        },
        body: JSON.stringify(currentId
          ? { document, preview, revision: revisionRef.current }
          : { document, preview }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409) {
        conflictRef.current = true;
        setStatus(`Save conflict: ${result.error || 'drawing changed elsewhere'}. Reload or copy your work before continuing.`);
        return false;
      }
      if (!response.ok) throw new Error(result.error || `Save failed (${response.status}).`);
      if (!validId(result.id) || !Number.isInteger(result.revision)) throw new Error('Server returned invalid save details.');
      idRef.current = result.id;
      revisionRef.current = result.revision;
      savedContentRef.current = savedContent;
      const hasNewChanges = changeVersion !== changeVersionRef.current
        && drawingContent(app.document) !== savedContent;
      changedDuringSave = hasNewChanges;
      dirtyRef.current = hasNewChanges;
      setCanSave(hasNewChanges);
      setStatus(hasNewChanges ? 'Unsaved changes' : 'Saved.');
      post({ type: 'drawing-saved', id: result.id, revision: result.revision });
      if (!hasNewChanges) {
        if (shareRef.current) {
          shareRef.current = 'awaiting';
          post({ type: 'drawing-share', id: result.id });
        }
        if (closeRef.current) {
          closeRef.current = false;
          post({ type: 'drawing-close' });
        }
      }
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed. Unsaved changes remain.');
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (changedDuringSave && !conflictRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => { void save(); }, 300);
      }
    }
  }, [loaded, post]);

  const queueSave = useCallback(() => {
    if (!loaded || !authorized || !appRef.current || (!idRef.current && !appRef.current.shapes.length)) return;
    changeVersionRef.current += 1;
    dirtyRef.current = true;
    setCanSave(true);
    setStatus('Unsaved changes');
    if (conflictRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (drawingContent(appRef.current.document) === savedContentRef.current) {
        if (idRef.current) {
          dirtyRef.current = false;
          setCanSave(false);
          setStatus('Saved.');
        } else {
          setStatus('Ready');
        }
      } else {
        void save();
      }
    }, 1200);
  }, [authorized, loaded, save]);

  useEffect(() => {
    const receive = async (event) => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'drawing-auth' && !authRef.current) {
        if (typeof message.username !== 'string' || typeof message.password !== 'string') {
          setStatus('Chat authentication was invalid.');
          return;
        }
        authRef.current = { username: message.username, password: message.password };
        setAuthorized(true);
        try {
          if (idRef.current) {
            if (!validId(idRef.current)) throw new Error('Invalid drawing URL.');
            const response = await fetch(`${API}/${idRef.current}`, { credentials: 'same-origin' });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `Could not load drawing (${response.status}).`);
            if (!result.document || !Number.isInteger(result.revision) || result.revision < 1) throw new Error('Server returned an invalid drawing.');
            initialDocument.current = result.document;
            revisionRef.current = result.revision;
          }
          setLoaded(true);
          setStatus('Ready');
          setCanSave(isNew);
          if (isNew) dirtyRef.current = true;
        } catch (error) {
          authRef.current = null;
          setAuthorized(false);
          setStatus(error instanceof Error ? error.message : 'Could not load drawing.');
        }
      } else if (message.type === 'drawing-share-result' && shareRef.current === 'awaiting') {
        shareRef.current = false;
        setStatus(message.ok ? 'Shared to chat.' : `Share failed: ${message.error || 'unknown error'}. Drawing remains saved.`);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);
  useEffect(() => { post({ type: 'drawing-ready' }); }, [post]);


  const onMount = useCallback((app) => {
    appRef.current = app;
    savedContentRef.current = drawingContent(app.document);
    setEditorReady(true);
  }, []);

  const handleSave = async (action) => {
    if (savingRef.current) return;
    clearTimeout(timerRef.current);
    if (idRef.current && dirtyRef.current && drawingContent(appRef.current.document) === savedContentRef.current) {
      dirtyRef.current = false;
      setCanSave(false);
    }
    if (action === 'share') shareRef.current = true;
    if (action === 'close') closeRef.current = true;
    if (dirtyRef.current) {
      const ok = await save();
      if (!ok) {
        shareRef.current = false;
        closeRef.current = false;
        return;
      }
    } else if (action === 'share') {
      shareRef.current = 'awaiting';
      post({ type: 'drawing-share', id: idRef.current });
    } else {
      closeRef.current = false;
      post({ type: 'drawing-close' });
    }
    // Parent response owns final share status.
  };

  const handleBack = () => {
    if (savingRef.current) return;
    const app = appRef.current;
    if (app && drawingContent(app.document) !== savedContentRef.current
        && !window.confirm('Discard unsaved drawing changes?')) return;
    post({ type: 'drawing-discard' });
  };

  return <main className="shell">
    <header className="topbar">
      <div className="brand"><button className="mark" aria-label="Close drawing" title="Close drawing" onClick={handleBack}>×</button><span>KuumIRC <small>DRAWING</small></span></div>
      <div className="actions">
        <span className={`status ${canSave ? 'pending' : ''}`} role="status">{saving ? 'Saving…' : status}</span>
        <button className="primary" disabled={!editorReady || saving} onClick={() => void handleSave(isNew ? 'share' : 'close')}>
          {isNew ? 'Save & send' : 'Save & close'}
        </button>
      </div>
    </header>
    <section className="canvas" aria-label="Drawing editor">
      {loaded && authorized ? <Tldraw
        document={initialDocument.current || undefined}
        onMount={onMount}
        onChange={queueSave}
        readOnly={false}
        disableAssets
        onAssetCreate={async () => false}
        showMultiplayerMenu={false}
      /> : <div className="gate" role="status">{status}</div>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
