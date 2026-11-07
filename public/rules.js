/* Clinical decision support rule base (shared by browser and server).
 * IMPORTANT: thresholds are ILLUSTRATIVE, based on WHO guidance cited in Table 3.6.
 * They must be reviewed and signed off by your clinical advisory panel against
 * current Ministry of Health and Child Care protocols before any real use. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
  const MATERNAL = ['antenatal', 'labour', 'postnatal'];

  function evaluate(o) {
    const out = [];
    const add = (rule_id, severity, message, action) => out.push({ rule_id, severity, message, action });
    const stage = o.stage;
    const sys = num(o.bp_sys), dia = num(o.bp_dia), pulse = num(o.pulse), temp = num(o.temp);
    const fhr = num(o.fhr), loss = num(o.blood_loss);
    const nbRr = num(o.nb_rr), nbTemp = num(o.nb_temp), nbWt = num(o.nb_weight);

    if (MATERNAL.includes(stage)) {
      if ((sys !== null && sys >= 160) || (dia !== null && dia >= 110)) {
        add('HTN-SEVERE', 'critical', `Severe hypertension (${sys ?? '?'}/${dia ?? '?'} mmHg)`,
          'Urgent senior review. Follow the severe pre-eclampsia/eclampsia protocol.');
      } else if ((sys !== null && sys >= 140) || (dia !== null && dia >= 90)) {
        add('HTN', 'warning', `Raised blood pressure (${sys ?? '?'}/${dia ?? '?'} mmHg)`,
          'Repeat measurement, check urine protein and symptoms, and assess for a hypertensive disorder.');
      }
      if (temp !== null && temp >= 38.0) {
        add('MAT-FEVER', 'warning', `Maternal fever (${temp} \u00b0C)`,
          'Assess for infection/sepsis and escalate per protocol.');
      }
      if (pulse !== null && pulse >= 120) {
        add('MAT-TACHY', 'warning', `Maternal tachycardia (${pulse} bpm)`,
          'Check for bleeding, infection or pain; reassess vital signs promptly.');
      }
    }
    if (stage === 'antenatal' || stage === 'labour') {
      if (fhr !== null && (fhr < 110 || fhr > 160)) {
        add('FHR', 'warning', `Abnormal fetal heart rate (${fhr} bpm)`,
          'Reassess and act per labour care guidance; consider position change, hydration and senior review.');
      }
    }
    if (stage === 'labour' || stage === 'postnatal') {
      if (loss !== null && loss >= 1000) {
        add('PPH-SEVERE', 'critical', `Severe blood loss (${loss} ml)`,
          'Activate the haemorrhage protocol and call for help immediately.');
      } else if (loss !== null && loss >= 500) {
        add('PPH', 'critical', `Postpartum haemorrhage threshold reached (${loss} ml)`,
          'Activate the haemorrhage protocol.');
      }
    }
    if (stage === 'newborn') {
      if (nbRr !== null && nbRr >= 60) {
        add('NB-RR', 'warning', `Newborn fast breathing (${nbRr}/min)`,
          'Assess the newborn for danger signs and escalate per protocol.');
      }
      if (nbTemp !== null && nbTemp < 36.5) {
        add('NB-HYPO', 'warning', `Newborn hypothermia risk (${nbTemp} \u00b0C)`,
          'Provide thermal protection (skin-to-skin, warm environment) and reassess.');
      }
      if (nbWt !== null && nbWt < 2.5) {
        add('NB-LBW', 'info', `Low birth weight (${nbWt} kg)`,
          'Plan additional newborn monitoring and feeding support per protocol.');
      }
    }
    return out;
  }

  return { evaluate, MATERNAL, VERSION: '0.1-illustrative' };
});
