document.addEventListener("DOMContentLoaded", () => {
  const zoomForm = document.getElementById("zoom-upload-form");

  function renderVisualizations(data) {
    const container = document.getElementById("visualizations");
    container.innerHTML = `
      <canvas id="speakingChart"></canvas>
      <canvas id="audienceEmotionChart"></canvas>
      <canvas id="eyeDirectionChart"></canvas>
      <canvas id="eyesMouthChart"></canvas>
    `;

    // Speaker vs Audience
    new Chart(document.getElementById("speakingChart"), {
      type: "pie",
      data: {
        labels: ["Speaker", "Audience"],
        datasets: [{
          data: [data.speakingRatio.speakerSpeakingFrames, data.speakingRatio.audienceSpeakingFrames],
          backgroundColor: ["#4a90e2","#f5a623"]
        }]
      },
      options: { responsive: true, plugins: { title: { display: true, text: "Speaker vs Audience Talking Time" } } }
    });

    // Audience Emotion Balance
    new Chart(document.getElementById("audienceEmotionChart"), {
      type: "pie",
      data: {
        labels: ["Positive", "Negative"],
        datasets: [{
          data: [data.audienceEmotionBalance.positive, data.audienceEmotionBalance.negative],
          backgroundColor: ["#50e3c2","#d0021b"]
        }]
      },
      options: { responsive: true, plugins: { title: { display: true, text: "Audience Emotion Balance" } } }
    });

    // Eye Direction
    new Chart(document.getElementById("eyeDirectionChart"), {
      type: "bar",
      data: {
        labels: Object.keys(data.eyeDirectionCounts),
        datasets: [{
          label: "Eye Directions",
          data: Object.values(data.eyeDirectionCounts),
          backgroundColor: ["#4a90e2","#f5a623","#50e3c2","#bd10e0"]
        }]
      },
      options: { responsive: true, plugins: { title: { display: true, text: "Eye Directions" } }, scales: { y: { beginAtZero: true } } }
    });

    // Eyes / Mouth
    new Chart(document.getElementById("eyesMouthChart"), {
      type: "bar",
      data: {
        labels: ["Eyes Open", "Mouth Open"],
        datasets: [{
          label: "Frames",
          data: [data.eyesMouthCounts.eyesOpen, data.eyesMouthCounts.mouthOpen],
          backgroundColor: ["#7ed321","#d0021b"]
        }]
      },
      options: { responsive: true, plugins: { title: { display: true, text: "Eyes / Mouth Open Counts" } }, scales: { y: { beginAtZero: true } } }
    });
  }

  zoomForm.addEventListener("submit", async e => {
    e.preventDefault();
    const file = zoomForm.zoomVideo.files[0];
    if (!file) return alert("Please select a video.");

    const formData = new FormData();
    formData.append("video", file);

    const button = zoomForm.querySelector("button");
    button.disabled = true;
    button.textContent = "Processing...";

    try {
      const res = await fetch("/upload-video", { method: "POST", body: formData });
      const data = await res.json();
      if (!data.success) return alert(data.error || "Upload failed");
      renderVisualizations(data);
    } catch (err) {
      alert("Error: " + err.message);
    } finally {
      button.disabled = false;
      button.textContent = "Upload and Analyze";
    }
  });
});
