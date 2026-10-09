// Stufen der Linie "Eingezahlt" im Reiter "Pool-Entwicklung" (LIQ#001254).
// Eingabe: investedSeries aus lib/pnl.js ([{ t, usd }], aufsteigend), sichtbarer Bereich [minT, maxT].
// Stand am linken Rand = letzte Stufe davor. Stufen NACH maxT werden auf maxT geklemmt statt
// verworfen: maxT ist der Live-Punkt der Anteil-Linie, und eine Einzahlung, die Millisekunden
// danach gebucht wurde, gilt am rechten Rand ("jetzt") bereits.

export function investedStepsInRange(inv, minT, maxT) {
    const steps = [];
    for (const e of inv ?? []) {
        if (e.t <= minT)      { steps.length = 0; steps.push({ t: minT, usd: e.usd }); }
        else if (e.t <= maxT) steps.push(e);
        else                  steps.push({ t: maxT, usd: e.usd });
    }
    return steps;
}
