import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js';
import { 
  getAuth, 
  onAuthStateChanged, 
  signInWithCustomToken, 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  setDoc,
  addDoc,
  query,
  where,
  onSnapshot,
  getDocs,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

// Global variables provided by Canvas environment
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Initialize Firebase with safety checks
let app = null;
let auth = null;
let db = null;
try {
  if (!firebaseConfig || Object.keys(firebaseConfig).length === 0) {
    console.warn('Firebase config appears empty. Halting Firebase init.');
    showModal('Configuration Required', 'Firebase configuration is missing. Set `__firebase_config` with your project config before loading the app.');
    hide($('#loading'));
  } else {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    console.debug('Firebase initialized');
  }
} catch (err) {
  console.error('Firebase initialization failed', err);
  showModal('Firebase Init Error', 'Failed to initialize Firebase: ' + (err && err.message));
  hide($('#loading'));
}

const QUICK_SURVEY_QUESTIONS = [
  { type: 'rating', prompt: 'How well did they start?' },
  { type: 'rating', prompt: 'How compelling was the presentation?' },
  { type: 'rating', prompt: 'Did they connect with the audience?' },
  { type: 'rating', prompt: 'How was the call to action/conclusion?' }
];

// UI helpers
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const show = el => {
    if (el) el.classList.remove('hidden');
};
const hide = el => {
    if (el) el.classList.add('hidden');
};

const modal = $('#modal');
const modalTitle = $('#modal-title');
const modalBody = $('#modal-body');
const modalOk = $('#modal-ok');

function showModal(title, html) {
  modalTitle.innerText = (typeof title === 'string' && title.length) ? title : 'Notice';
  modalBody.innerHTML = (typeof html === 'string' && html.length) ? html : '<div style="min-height:20px;color:var(--muted)">No details provided.</div>';
  console.debug('showModal:', modalTitle.innerText, modalBody.innerText || modalBody.innerHTML);
  show(modal);
  modalOk.focus();
}
// close handlers: button, backdrop click, and ESC
modalOk.addEventListener('click', () => hide(modal));
modal.addEventListener('click', (e) => {
  if (e.target === modal) hide(modal);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hide(modal);
});

function sanitizeInput(str) {
    if (typeof str !== 'string') return '';
    return escapeHtml(str.trim());
}

function toggleButtonLoading(button, isLoading) {
    if (!button) return;
    const originalText = button.dataset.originalText || button.innerText;
    button.dataset.originalText = originalText;
    button.disabled = isLoading;
    if (isLoading) {
        button.innerText = 'Processing...';
        button.style.opacity = '0.7';
    } else {
        button.innerText = originalText;
        button.style.opacity = '1';
    }
}

// Authentication flow and URL mode parsing
let userId = null;
let _triedCustomToken = false;
let isAuthReady = false;
let _authReadyResolve;
const authReady = new Promise((res) => { _authReadyResolve = res; });

const urlParams = new URLSearchParams(window.location.search);
const urlMode = urlParams.get('mode');
const urlSurveyId = urlParams.get('surveyId');

if (auth) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      userId = auth.currentUser.uid;
      if (!isAuthReady) {
        isAuthReady = true;
        _authReadyResolve();
      }
      await afterAuthReady();
    } else {
      // NEW: If no user, show the profile/sign-in page immediately
      hide($('#loading'));
      show($('#profile-setup'));
      setupAuthForms();
    }
  });
} else {
  console.debug('Auth not initialized; skipping auth listener registration');
}

// Wait until authenticated, then choose view (response-mode or normal flow)
async function afterAuthReady() {
  if (!userId) userId = auth.currentUser && auth.currentUser.uid;
  if (!userId) return;

  // 1. Handle Response Mode (Highest Priority)
  if (urlMode === 'response' && urlSurveyId) {
    hide($('#loading'));
    hide($('#dashboard'));
    hide($('#profile-setup'));
    show($('#response-mode'));
    await loadResponseForm(urlSurveyId);
    return;
  }

  // 2. Standard profile/dashboard flow
  const profileRef = doc(db, `artifacts/${appId}/users/${userId}/profiles/user_profile`);
  const profileSnap = await getDoc(profileRef);
  
  // Always hide the initial loading screen now that we have a plan
  hide($('#loading'));
  
  if (!profileSnap.exists()) {
    // 3A. New User (Auth exists, but no profile metadata)
    // This happens right after sign-up, or if an account was created externally without metadata.
    
    // 🔥 CRITICAL: Must hide the dashboard if it was shown previously
    hide($('#dashboard'));
    show($('#profile-setup'));
    setupAuthForms(); 
  } else {
    // 3B. Returning User (Auth exists and profile metadata exists)
    
    // 🔥 CRITICAL: Must hide the setup form before showing dashboard
    const data = profileSnap.data();
    hide($('#profile-setup')); 
    showDashboard(data);
  }
}

/**
 * Handles the creation of the user's metadata document in Firestore.
 */
async function handleProfileCreation(uid, data) {
  const profileRef = doc(db, `artifacts/${appId}/users/${uid}/profiles/user_profile`);
  const payload = {
    firstName: data.firstName,
    email: data.email,
    ageGroup: data.ageGroup,
    institutionType: data.institutionType,
    points: 0,
    createdAt: serverTimestamp()
  };
  try {
    await setDoc(profileRef, payload, { merge: true });
    
    // CRITICAL FIX: TRANSITION TO DASHBOARD AFTER PROFILE SAVE
    hide($('#profile-setup'));
    showDashboard(payload);
    // END FIX

  } catch (err) {
    console.error('Profile save failed after sign-up:', err);
    showModal('Critical Error', 'Successfully created user but failed to save profile data.');
  }
}

/**
 * NEW: Handles toggling and logic for Sign Up and Sign In forms.
 */
function setupAuthForms() {
  const signupForm = $('#signup-form');
  const signinForm = $('#signin-form');
  const toggleSignup = $('#toggle-signup');
  const toggleSignin = $('#toggle-signin');
  const setupTitle = $('#setup-title');

  function toggleForms(isSignUp) {
    // 1. Visually toggle the buttons
    toggleSignup.classList.toggle('primary', isSignUp);
    toggleSignin.classList.toggle('primary', !isSignUp);
    setupTitle.innerText = isSignUp ? 'Create Your Profile' : 'Sign In';
    
    // 2. Explicitly hide one and show the other
    if (isSignUp) {
      hide(signinForm); 
      show(signupForm); 
    } else {
      hide(signupForm); 
      show(signinForm); 
    }
  }

  // --- Wire up the toggle buttons immediately ---
  toggleSignup.addEventListener('click', () => toggleForms(true));
  toggleSignin.addEventListener('click', () => toggleForms(false));

  // --- Sign Up Submission ---
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const signupBtn = $('#signup-btn');
    toggleButtonLoading(signupBtn, true);

    const fd = new FormData(signupForm);
    const email = sanitizeInput(fd.get('email'));
    const password = fd.get('password');
    const profileData = {
        firstName: sanitizeInput(fd.get('firstName')),
        email: email,
        ageGroup: fd.get('ageGroup'),
        institutionType: fd.get('institutionType')
    };
    
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        await handleProfileCreation(userCredential.user.uid, profileData);
    } catch (err) {
        let message = 'Sign Up Failed.';
        if (err.code === 'auth/email-already-in-use') {
            message = 'This email is already registered. Please sign in instead.';
        } else if (err.code === 'auth/weak-password') {
            message = 'Password is too weak. Must be at least 6 characters.';
        } else {
            message += ' ' + (err.message || '');
        }
        showModal('Error', message);
    } finally {
        toggleButtonLoading(signupBtn, false);
    }
  });

  // --- Sign In Submission ---
  signinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const signinBtn = $('#signin-btn');
    toggleButtonLoading(signinBtn, true);

    const fd = new FormData(signinForm);
    const email = sanitizeInput(fd.get('email'));
    const password = fd.get('password');
    
    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
        let message = 'Sign In Failed.';
        if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') {
            message = 'Invalid email or password.';
        } else {
            message += ' ' + (err.message || '');
        }
        showModal('Error', message);
    } finally {
        toggleButtonLoading(signinBtn, false);
    }
  });

  // Default to Sign Up view
  toggleForms(true);
}

// Dashboard setup
let surveysUnsub = null;
const surveysCollectionPath = `artifacts/${appId}/public/data/surveys`;
const responsesCollectionPath = `artifacts/${appId}/public/data/responses`;

function setupCopyButton(urlElementId, buttonElementId) {
    const copyBtn = $(`#${buttonElementId}`);
    const urlElement = $(`#${urlElementId}`);
    
    if (!copyBtn || !urlElement) return;

    copyBtn.addEventListener('click', async () => {
        const url = urlElement.innerText;
        try {
            await navigator.clipboard.writeText(url);
            copyBtn.innerText = 'Copied!';
            setTimeout(() => { copyBtn.innerText = 'Copy Link'; }, 2000);
        } catch (err) {
            console.error('Failed to copy URL:', err);
            showModal('Error', 'Failed to copy link. Please copy it manually.');
            copyBtn.innerText = 'Error';
        }
    });
}

function showDashboard(profileData) {
  $('#user-name').innerText = profileData.firstName || 'User';
  $('#user-points').innerText = 'Points: ' + (profileData.points || 0);
  $('#welcome-msg').innerText = `Hello ${profileData.firstName || ''}, manage your surveys and collect feedback.`;
  show($('#dashboard'));

  // Tabs (Wired to all elements with data-tab, including buttons in the dashboard view)
  $$('[data-tab]').forEach(btn => btn.addEventListener('click', (ev) => {
    $$('.tab').forEach(b => b.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    
    const targetButton = ev.target.closest('[data-tab]');
    if (targetButton) {
        targetButton.classList.add('active');
        const tab = targetButton.dataset.tab;
        // Also ensure the header tab is active if clicked from dashboard grid
        const headerTab = $(`.tab[data-tab="${tab}"]`);
        if (headerTab) headerTab.classList.add('active'); 
        
        $(`#tab-${tab}`).classList.add('active');
        // Hide share panel when switching tabs
        if (tab !== 'create') {
            hide($('#share-panel'));
        }
    }
  }));


  // Survey create
  setupCreateSurvey();

  // Real-time surveys created count and list
  const surveysRef = collection(db, surveysCollectionPath);
  const q = query(surveysRef, where('creatorId', '==', userId));
  if (surveysUnsub) surveysUnsub();
  surveysUnsub = onSnapshot(q, async (snap) => {
    $('#surveys-count').innerText = 'Surveys Created: ' + snap.size;
    renderMySurveys(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

// Create survey UI
let questions = [];
function setupCreateSurvey() {
  const qList = $('#questions-list');
  const form = $('#create-survey-form');
  const addText = $('#add-text');
  const addRating = $('#add-rating');
  const sharePanel = $('#share-panel');
  const createBtn = $('#create-survey-btn');
  const loadQuickBtn = $('#load-quick-survey-btn'); // Correctly selected here

  function renderQuestions() {
    qList.innerHTML = '';
    questions.forEach((q, idx) => {
      const el = document.createElement('div');
      el.className = 'question-row';
      const safePrompt = escapeHtml(q.prompt || '');
      el.innerHTML = `
        <input class="q-prompt" data-idx="${idx}" value="${safePrompt}" placeholder="Question text" />
        <div class="q-type">${q.type === 'rating' ? 'Rating 1-5' : 'Text'}</div>
        <button type="button" class="btn small" data-idx="${idx}" data-action="remove">Remove</button>
      `;
      qList.appendChild(el);
    });
    // wire inputs
    $$('.question-row .q-prompt').forEach(inp => inp.addEventListener('input', (e) => {
      const i = +e.target.dataset.idx; 
      questions[i].prompt = sanitizeInput(e.target.value);
    }));
    $$('.question-row button[data-action="remove"]').forEach(btn => btn.addEventListener('click', (e) => {
      const i = +e.target.dataset.idx; questions.splice(i,1); renderQuestions();
    }));
  } // End of renderQuestions

  // Wire up 'Add' buttons and initialize
  addText.addEventListener('click', () => { questions.push({ type: 'text', prompt: '' }); renderQuestions(); });
  addRating.addEventListener('click', () => { questions.push({ type: 'rating', prompt: '' }); renderQuestions(); });
  renderQuestions(); // Initial call to show empty list

  // --- Load Quick Survey functionality ---
  loadQuickBtn.addEventListener('click', () => {
    questions = []; 
    questions = JSON.parse(JSON.stringify(QUICK_SURVEY_QUESTIONS)); 
    form.title.value = "Quick Presentation Feedback";
    renderQuestions();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    toggleButtonLoading(createBtn, true);

    const title = sanitizeInput(form.title.value);
    
    if (!title) {
      console.debug('showModal call (validation) - missing title');
      toggleButtonLoading(createBtn, false);
      return showModal('Validation', 'Please enter a survey title.');
    }
    const validQuestions = questions.filter(q => q.prompt && q.prompt.length > 0);

    if (!validQuestions.length) {
      console.debug('showModal call (validation) - no valid questions');
      toggleButtonLoading(createBtn, false);
      return showModal('Validation', 'Add at least one question with text.');
    }
    try {
      const surveysRef = collection(db, surveysCollectionPath); 
      const payload = { 
        title, 
        questions: validQuestions, 
        creatorId: userId, 
        createdAt: serverTimestamp() 
      };
      
      const docRef = await addDoc(surveysRef, payload);
      
      // 1. Award Points
      await grantPointToUser(userId, 5); 
      
      // 2. Clear the form and reset state
      form.reset();
      questions = []; 
      renderQuestions(); 
      
      // 3. Generate Share Link and QR Code
      const shareUrl = `${window.location.origin}${window.location.pathname}?mode=response&surveyId=${docRef.id}`;
      $('#share-url').innerText = shareUrl;
      
      setupCopyButton('share-url', 'copy-btn'); 
      
      $('#qrcode').innerHTML = '';
      new QRCode(document.getElementById('qrcode'), { text: shareUrl, width: 180, height: 180 });
      
      show(sharePanel);
      
      showModal('Success!', 'Your survey was created and is ready to share.');

    } catch (err) {
      console.error('Survey creation failed:', err);
      showModal('Error', 'Unable to create survey: ' + (err && err.message));
    } finally {
      toggleButtonLoading(createBtn, false);
    }
  });
}

// Render my surveys list
function renderMySurveys(surveys) {
  const container = $('#my-surveys-list');
  container.innerHTML = '';
  surveys.forEach(s => {
    const row = document.createElement('div');
    row.className = 'survey-row';
    row.innerHTML = `<div class="survey-title">${escapeHtml(s.title)}</div>
      <div class="survey-meta">ID: ${s.id}</div>
      <button class="btn small view" data-id="${s.id}" data-title="${escapeHtml(s.title)}">View Responses</button>`;
    container.appendChild(row);
  });
  $$('.survey-row .view').forEach(btn => btn.addEventListener('click', async (e) => {
    const id = e.target.dataset.id; 
    const title = e.target.dataset.title;
    $('#responses-survey-title').innerText = title;
    show($('#responses-panel'));
    const responsesRef = collection(db, responsesCollectionPath);
    const q = query(responsesRef, where('surveyId', '==', id));
    onSnapshot(q, snap => {
      const list = $('#responses-list'); 
      list.innerHTML = '';
      const sortedResponses = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => b.createdAt?.toMillis() - a.createdAt?.toMillis());

      sortedResponses.forEach(r => {
        const li = document.createElement('div'); 
        li.className = 'response-row'; 
        const answersText = r.answers.map(a => 
            `${a.prompt.substring(0, 30)}... [${a.type.toUpperCase()}] -> "${sanitizeInput(a.answer).substring(0, 50)}"`
        ).join('; ');
        const timeString = r.createdAt?.toDate().toLocaleTimeString() || 'N/A';
        
        li.innerHTML = `<strong>${timeString}</strong> - ${answersText} <span class="text-muted" style="float:right;">ID: ${r.id.substring(0, 4)}...</span>`;
        list.appendChild(li);
      });
    });
  }));
}

async function loadResponseForm(surveyId) {
  try {
    const surveyRef = doc(db, surveysCollectionPath, surveyId);
    const snap = await getDoc(surveyRef);
    if (!snap.exists()) {
      console.debug('showModal call (survey not found) - surveyId:', surveyId);
      return showModal('Not found', 'Survey not found');
    }
    const data = snap.data();
    $('#response-title').innerText = data.title || 'Survey';
    const form = $('#response-form'); form.innerHTML = '';
    data.questions.forEach((q, idx) => {
      const wrapper = document.createElement('div');
      const label = document.createElement('label'); label.innerText = q.prompt || `Question ${idx+1}`;
      wrapper.appendChild(label);
      if (q.type === 'rating') {
        const input = document.createElement('input'); 
        input.type = 'range'; 
        input.min = 1; 
        input.max = 5; 
        input.value = 3; 
        input.name = 'q' + idx;
        const valueDisplay = document.createElement('span');
        valueDisplay.id = `range-value-${idx}`;
        valueDisplay.innerText = ` (Current: 3)`;
        input.addEventListener('input', (e) => {
            valueDisplay.innerText = ` (Current: ${e.target.value})`;
        });

        wrapper.appendChild(input);
        wrapper.appendChild(valueDisplay);

      } else {
        const ta = document.createElement('textarea'); ta.name = 'q' + idx; ta.rows = 3; wrapper.appendChild(ta);
      }
      form.appendChild(wrapper);
    });
    const submit = document.createElement('div'); 
    submit.className = 'actions'; 
    submit.innerHTML = '<button class="btn primary" id="response-submit-btn">Submit Feedback</button>';
    form.appendChild(submit);

    const submitBtn = $('#response-submit-btn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      toggleButtonLoading(submitBtn, true);

      const fd = new FormData(form);
      const answers = data.questions.map((q, idx) => ({ 
          type: q.type, 
          prompt: q.prompt, 
          answer: sanitizeInput(fd.get('q'+idx)) 
      }));
      
      try {
        await addDoc(collection(db, responsesCollectionPath), { 
            surveyId, 
            surveyTitle: data.title, 
            answers, 
            createdAt: serverTimestamp() 
        });
        if (data.creatorId) await grantPointToUser(data.creatorId, 1);
        hide($('#response-mode'));
        show($('#thankyou'));
      } catch (err) {
        console.debug('showModal call (response submit error) - preparing to show response submit error', { error: err });
        showModal('Error', 'Unable to submit response: ' + (err && err.message));
        toggleButtonLoading(submitBtn, false);
      }
    });
  } catch (err) {
    console.debug('showModal call (load survey error) - preparing to show load survey error', { error: err });
    showModal('Error', 'Unable to load survey: ' + (err && err.message));
  }
}

// Points awarding (read -> increment -> setDoc merge:true)
async function grantPointToUser(targetUserId, amount) {
  if (!targetUserId) return;
  const ref = doc(db, `artifacts/${appId}/users/${targetUserId}/profiles/user_profile`);
  try {
    const snap = await getDoc(ref);
    const current = (snap.exists() && snap.data().points != null) ? snap.data().points : 0;
    await setDoc(ref, { points: current + amount }, { merge: true });
  } catch (err) {
    console.warn('grantPointToUser failed', err);
  }
}

// Utility
function escapeHtml(s){ return String(s).replace(/[&<>"]+/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// Dev panel wiring (show on localhost or when ?dev=1)
(function setupDevPanel(){
  try {
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const params = new URLSearchParams(window.location.search);
    const showDev = isLocal || params.get('dev') === '1';
    const panel = document.getElementById('dev-panel');
    const btnClose = document.getElementById('dev-close');
    const btnApply = document.getElementById('dev-apply');
    const cfgInput = document.getElementById('dev-config');
    const appIdInput = document.getElementById('dev-appid');
    const tokenInput = document.getElementById('dev-token');
    if (!panel) return;
    if (showDev) panel.classList.remove('hidden');
    btnClose.addEventListener('click', () => panel.classList.add('hidden'));
    btnApply.addEventListener('click', () => {
      const raw = cfgInput.value.trim();
      try {
        if (raw) JSON.parse(raw); // validate
        if (raw) window.__firebase_config = raw;
        if (appIdInput.value.trim()) window.__app_id = appIdInput.value.trim();
        if (tokenInput.value.trim()) window.__initial_auth_token = tokenInput.value.trim();
        // reload to apply
        location.reload();
      } catch (err) {
        showModal('Invalid JSON', 'The Firebase config JSON is invalid: ' + (err && err.message));
      }
    });
  } catch (e) { console.warn('Dev panel setup failed', e); }
})();