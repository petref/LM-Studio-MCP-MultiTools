// Simple client that posts to /chat and displays the response

async function send() {
 const textarea = document.getElementById('input');
 const output  = document.getElementById('output');

 const message = textarea.value.trim();
 if (!message) return;

 output.textContent = '…';

 try {
   const res = await fetch('/chat', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ messages: [{ role: 'user', content: message }] }),
   });

   if (!res.ok) throw new Error(`HTTP ${res.status}`);
   const data = await res.json();
   output.textContent = JSON.stringify(data, null, 2);
 } catch (e) {
   output.textContent = `Error: ${e.message}`;
 }
}

window.send = send;