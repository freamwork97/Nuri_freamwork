document.getElementById('open').onclick = () => chrome.runtime.sendMessage({ type: 'anb:openPanel' });
