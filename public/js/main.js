document.addEventListener("DOMContentLoaded", () => {
  const zoomForm = document.getElementById("zoom-upload-form");

  function renderVisualizations(timeline) {
    const container = document.getElementById("visualizations");
    container.innerHTML = `
      <canvas id="emotionChart"></canvas>
      <canvas id="smileChart"></canvas>
      <canvas id="eyeDirectionChart"></canvas>
      <canvas id="eyesMouthChart"></canvas>
    `;

    const labels = timeline.map(f => f.timestamp_seconds);

    new Chart(document.getElementById("emotionChart"), {
      type: "line",
      data: { labels, datasets: [{ label: "Emotion Confidence", data: timeline.map(f => f.confidence || 0), borderColor: "#4a90e2", backgroundColor: "rgba(74,144,226,0.2)", fill: true, tension: 0.2 }] },
      options: { responsive: true, plugins: { title: { display: true, text: "Emotion Confidence Timeline" } }, scales: { y: { min: 0, max: 100 } } }
    });

    new Chart(document.getElementById("smileChart"), {
      type: "line",
      data: { labels, datasets: [{ label: "Smile Confidence", data: timeline.map(f => f.smileConfidence || 0), borderColor: "#f5a623", backgroundColor: "rgba(245,166,35,0.2)", fill: true, tension: 0.2 }] },
      options: { responsive: true, plugins: { title: { display: true, text: "Smile Confidence Over Time" } }, scales: { y: { min: 0, max: 100 } } }
    });

    const directions = { Left: 0, Right: 0, Center: 0, Unknown: 0 };
    timeline.forEach(f => directions[f.eyeDirection]++);
    new Chart(document.getElementById("eyeDirectionChart"), {
      type: "bar",
      data: { labels: Object.keys(directions), datasets: [{ label: "Eye Direction Counts", data: Object.values(directions), backgroundColor: ["#4a90e2","#f5a623","#50e3c2","#bd10e0"] }] },
      options: { responsive: true, plugins: { title: { display: true, text: "Eye Direction Distribution" } }, scales: { y: { beginAtZero: true } } }
    });

    const eyesOpenCount = timeline.filter(f => f.eyesOpen).length;
    const mouthOpenCount = timeline.filter(f => f.mouthOpen).length;
    new Chart(document.getElementById("eyesMouthChart"), {
      type: "bar",
      data: { labels: ["Eyes Open", "Mouth Open"], datasets: [{ label: "Frames", data: [eyesOpenCount, mouthOpenCount], backgroundColor: ["#7ed321","#d0021b"] }] },
      options: { responsive: true, plugins: { title: { display: true, text: "Eyes / Mouth Open Counts" } }, scales: { y: { beginAtZero: true } } }
    });
  }

  zoomForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = zoomForm.zoomVideo.files[0];
    if (!file) return alert("Select a video file");

    const formData = new FormData();
    formData.append("video", file);

    const btn = zoomForm.querySelector("button");
    btn.disabled = true; btn.textContent = "Processing...";

    try {
      const res = await fetch("/upload-video", { method: "POST", body: formData });
      if (!res.ok) throw new Error("Upload failed");

      const data = await res.json();
      if (data.success) renderVisualizations(data.timeline);
      else alert("Error: " + data.error);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false; btn.textContent = "Upload and Analyze";
    }
  });
});
