#let doc = json(bytes(sys.inputs.document))
#set page(paper: "us-letter", margin: (x: 0.7in, y: 0.6in))
#set text(font: "Libertinus Serif", size: 10.5pt)
#set par(leading: 0.55em, spacing: 0.7em)
#show heading.where(level: 1): it => block(above: 12pt, below: 6pt,
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
#heading(level: 1)[Summary]
#value(doc, "summary")
#if doc.work.len() > 0 { heading(level: 1)[Experience] }
#for work in doc.work {
  block(breakable: false)[
    #strong(value(work, "position")) — #value(work, "name")
    #h(1fr) #text(size: 9pt, dates(work, present: true))
  ]
  if work.bullets.len() > 0 {
    list(..work.bullets.map(b => text(b)))
  } else { text(value(work, "summary")) }
}
#if doc.projects.len() > 0 { heading(level: 1)[Projects] }
#for project in doc.projects {
  block(breakable: false)[
    #strong(value(project, "name"))
    #let details = joined((value(project, "entity"), joined(project.at("roles", default: ()))).filter(v => v != ""))
    #if details != "" { [ — #details] }
    #if value(project, "url").starts-with("https://") { [ · #safe-link(value(project, "url"), "Link")] }
  ]
  text(value(project, "text"))
  parbreak()
}
#if doc.skills.len() > 0 { heading(level: 1)[Skills] }
#for skill in doc.skills {
  [#strong(value(skill, "name")): #joined(skill.at("keywords", default: ())) #parbreak()]
}
#if doc.education.len() > 0 { heading(level: 1)[Education] }
#for education in doc.education {
  [#strong(value(education, "institution")) — #joined((value(education, "studyType"), value(education, "area")).filter(v => v != "")) #h(1fr) #dates(education)#if value(education, "note") != "" { [ (#value(education, "note"))] } #parbreak()]
}
#if doc.awards.len() + doc.certificates.len() > 0 { heading(level: 1)[Awards & Certificates] }
#for award in doc.awards {
  [#strong(value(award, "title")) — #value(award, "awarder") #h(1fr) #date(value(award, "date")) #parbreak()]
}
#for certificate in doc.certificates {
  [#strong(value(certificate, "name")) — #value(certificate, "issuer") #h(1fr) #date(value(certificate, "date")) #parbreak()]
}
