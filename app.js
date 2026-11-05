// Datos ficticios para demostrar la interfaz. Sustituir por información validada por Damm.
const machines = [
  {code:"ENV-001",name:"Envasadora de ejemplo",area:"Línea de envasado",status:"Documentación demo"},
  {code:"ETQ-002",name:"Etiquetadora de ejemplo",area:"Línea de etiquetado",status:"Documentación demo"},
  {code:"PAL-003",name:"Paletizador de ejemplo",area:"Final de línea",status:"En revisión"}
];
const incidents = [
  {title:"Parada de ejemplo: sensor",machine:"ENV-001 · Caso simulado",status:"Caso de demostración"},
  {title:"Aviso de ejemplo: etiquetado",machine:"ETQ-002 · Caso simulado",status:"Pendiente de validar"},
  {title:"Consulta de ejemplo: reinicio",machine:"PAL-003 · Caso simulado",status:"No es un procedimiento real"}
];
document.querySelector("#machine-list").innerHTML = machines.map(m => `<div class="machine-row"><div><strong>${m.name}</strong><small>${m.area} · ${m.code}</small></div><span class="status">${m.status}</span></div>`).join("");
document.querySelector("#incident-list").innerHTML = incidents.map(i => `<div class="incident-row"><div><strong>${i.title}</strong><small>${i.machine}</small></div><span class="status review">${i.status}</span></div>`).join("");
document.querySelector("#learning-button").addEventListener("click", () => {
  document.querySelector("#learning-message").textContent = "Cápsula demo: identifica siempre la máquina y consulta el procedimiento oficial. No realices intervenciones sin autorización.";
});