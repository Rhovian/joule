#let doc = json(bytes(sys.inputs.document))
#set page(paper: "us-letter", margin: (x: 0.7in, y: 0.6in))
#set text(font: "Libertinus Serif", size: 10.5pt)
#set par(leading: 0.62em, spacing: 0.62em, justify: false)
#set list(spacing: 0.5em, indent: 0.4em, body-indent: 0.6em)
#show heading.where(level: 1): it => block(above: 16pt, below: 8pt, sticky: true,
  stack(dir: ttb, spacing: 2pt, text(size: 12pt, weight: "bold", it.body),
    line(length: 100%, stroke: 0.4pt)))
#let value(entry, key) = { let v = entry.at(key, default: ""); if v == none { "" } else { str(v) } }
#let joined(values) = if values.len() == 0 { "" } else { values.map(v => str(v)).join(" · ") }
#let date(raw) = if raw.match(regex("^[0-9]{4}-(0[1-9]|1[0-2])$")) != none {
  let months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
  months.at(int(raw.slice(5)) - 1) + " " + raw.slice(0, 4)
} else { raw }
#let dates(entry, present: false) = {
  let start = date(value(entry, "startDate"))
  let end = date(value(entry, "endDate"))
  if start == "" { end } else if end == "" {
    if present { start + " – Present" } else { start }
  } else { start + " – " + end }
}
#let safe-link(url, label) = link(url, text(label))
#let basics = doc.at("basics", default: (:))
#text(size: 23pt, weight: "bold", value(basics, "name"))
#linebreak()
#text(size: 12pt, value(basics, "label"))
#parbreak()
#value(basics, "email")
#let location = basics.at("location", default: (:))
#let place = joined(("city", "region", "countryCode").map(k => value(location, k)).filter(v => v != ""))
#if place != "" { [ · #place] }
#for profile in basics.at("profiles", default: ()) {
  if value(profile, "url").starts-with("https://") {
    [ · #safe-link(value(profile, "url"), value(profile, "network"))]
  }
}
#let entry(title, right: "", above: 11pt) = block(above: above, below: 6pt, sticky: true)[#title #h(1fr) #text(size: 9pt, right)]
#let project-entry(project) = {
  let details = joined((value(project, "entity"), joined(project.at("roles", default: ()))).filter(v => v != ""))
  entry[#strong(value(project, "name"))#if details != "" { [ — #details] }#if value(project, "url").starts-with("https://") { [ · #safe-link(value(project, "url"), value(project, "url").trim("https://", at: start))] }]
  text(value(project, "text"))
  if value(project, "relevance") != "" {
    block(above: 4pt, inset: (left: 1.2em), text(style: "italic", size: 9.5pt, fill: luma(80))[Relevance: #value(project, "relevance")])
  }
}
#heading(level: 1)[Summary]
#value(doc, "summary")
#if doc.skills.len() > 0 { heading(level: 1)[Skills] }
#for skill in doc.skills {
  block(above: 0.5em, below: 0.5em)[#strong(value(skill, "name")): #joined(skill.at("keywords", default: ()))]
}
#let open-source = doc.projects.filter(p => p.at("type", default: none) == "open-source")
#let projects = doc.projects.filter(p => p.at("type", default: none) != "open-source")
#if open-source.len() > 0 { heading(level: 1)[Open Source Contributions] }
#for project in open-source { project-entry(project) }
#let experience = doc.work.filter(w => w.bullets.len() > 0)
#let earlier = doc.work.filter(w => w.bullets.len() == 0)
#if experience.len() > 0 { heading(level: 1)[Experience] }
#for work in experience {
  entry([#strong(value(work, "position")) — #value(work, "name")], right: dates(work, present: true))
  list(..work.bullets.map(b => block(breakable: false, text(b))))
}
#if earlier.len() > 0 { heading(level: 1)[Earlier Experience] }
#for work in earlier {
  block(above: 0.55em, below: 0.55em, breakable: false)[#strong[#value(work, "position"), #value(work, "name")] #text(fill: luma(90))[(#dates(work))] — #value(work, "summary")]
}
#if projects.len() > 0 { heading(level: 1)[Projects] }
#for project in projects { project-entry(project) }
#if doc.education.len() > 0 { heading(level: 1)[Education] }
#for education in doc.education {
  entry([#strong(value(education, "institution")) — #joined((value(education, "studyType"), value(education, "area")).filter(v => v != ""))], above: 7pt, right: [#dates(education)#if value(education, "note") != "" { [ (#value(education, "note"))] }])
}
#if doc.awards.len() + doc.certificates.len() > 0 { heading(level: 1)[Awards & Certificates] }
#for award in doc.awards {
  entry([#strong(value(award, "title")) — #value(award, "awarder")], above: 7pt, right: date(value(award, "date")))
}
#for certificate in doc.certificates {
  entry([#strong(value(certificate, "name")) — #value(certificate, "issuer")], above: 7pt, right: date(value(certificate, "date")))
}
