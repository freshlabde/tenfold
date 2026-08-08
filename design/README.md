# tenfold — Gestaltungsrichtungen

Drei Entwürfe für dieselbe App, bewusst nicht drei Farbvarianten desselben Entwurfs,
sondern drei verschiedene Grundhaltungen. Jede Datei ist eigenständig: keine
Fremdbibliothek, kein CDN, keine geladene Schrift, alles CSS inline. Doppelklick
genügt, oder über den Dev-Server:

```bash
cd /Users/kaira/tenfold && node tools/serve.js
# http://127.0.0.1:7710/design/direction-a.html   (b, c analog)
```

Jede Datei zeigt vier Bildschirme in echten iPhone-Maßen (**Screen exakt 390 × 844 px**,
Rahmen als `box-shadow`-Ring, damit das Element selbst 390 px breit bleibt):

1. **Die Zehn** — Wurzelliste in Rangfolge
2. **Fokus** — in Platz 3 hineingezoomt, mit Brotkrume und Teilzielen
3. **Duell** — mitten in der Wischbewegung, mit Fortschritt „7 von etwa 22"
4. **Ein Blatt** — ein To-do in der Detailansicht mit Fertig-Kriterium

Oben rechts in jeder Datei liegt ein Schalter **„Helles Thema prüfen"** — er kippt
`data-theme` auf `light`. Beide Themen sind vollständig über CSS-Variablen definiert;
kein Wert ist am Token-System vorbei hart codiert. Safe-Area ist über
`padding-top: max(--sa-top, env(safe-area-inset-top))` gelöst, die Höhe ist in der
App `100dvh` (im Entwurf auf 844 px festgenagelt, damit sich die Rahmen vergleichen
lassen). Symbole sind ausnahmslos Inline-SVG, keine Emojis.

Geprüft mit Playwright über den Dev-Server: kein Bildschirm läuft vertikal oder
horizontal über, alle zehn Wurzelpunkte sind auf Screen 1 gleichzeitig sichtbar,
`document.body` hat in keiner Datei horizontalen Überlauf.

---

## A — „Register" · das gesetzte Buch

**Grundhaltung.** Ein Verzeichnis, kein Dashboard. Serifenschrift durchgehend,
getrennt wird nur durch Haarlinien und Weißraum. Keine Karten, keine Radien, keine
Schatten, keine Flächen — die einzige gefüllte Fläche der ganzen App ist der
„Erledigt"-Knopf auf dem Blatt. Die Rangziffer steht groß und tabellarisch in der
Marge und trägt die Ordnung, bevor man den ersten Titel liest. Der Zinnober kommt
exakt dreimal vor: Platz 1, der laufende Schritt, die eine Primäraktion unten.
Auf dem Fokus-Bildschirm steht die Ziffer „3" als 210-px-Wasserzeichen hinter der
Überschrift und der Titel hat noch eine weiche Bewegungsspur — man sieht, woher man
gerade gekommen ist.

**Wofür sie gut ist.** Für den Ton der Aufgabenstellung: ernst, ruhig, persönlich.
Sie sieht keiner Produktivitäts-App ähnlich, sie sieht aus wie etwas, das man
aufschlägt. Sie altert nicht, weil sie keine Mode mitmacht. Sie ist die einzige der
drei, deren helles Thema *besser* aussieht als das dunkle — bei einer App, die
jahrelang und auch tagsüber benutzt wird, ist das kein Detail.

**Was sie kostet.** Sie hängt an `ui-serif`. Auf iPhone und Mac ist das New York,
eine wirklich gute Schrift, und dort trägt der Entwurf. Auf Android und Windows
fällt die Kette auf Palatino oder Times zurück — die Anmutung wird dann deutlich
gewöhnlicher. Zweitens: Haarlinien-Layouts vertragen keine Nachlässigkeit. Jede neue
Zeile, jedes neue Feld muss ins Raster, sonst zerfällt der Satz sofort sichtbar.
Drittens fehlen Trefferflächen als sichtbare Objekte — die ganze Zeile ist tippbar,
aber nichts *zeigt* das an.

**Tokens.**

| | dunkel | hell |
|---|---|---|
| Grund | `#100E0C` warmes Tiefschwarz | `#F4F0E7` Werkdruckpapier |
| Schrift | `#EDE6D9` | `#17140F` |
| Akzent | `#C8532C` Zinnober | `#A93B18` |
| Linien | `rgba(ink,.13)` / `.07` | `rgba(ink,.18)` / `.09` |

Schriften `ui-serif, New York, Iowan Old Style, Palatino` für alles Inhaltliche,
`ui-sans-serif` nur für Mikro-Etiketten in Versalien mit `.18–.36em` Laufweite.
Radius **0**. Schatten **keiner**. Satzspiegel 26 px. Korn 5 % als Inline-SVG-Rauschen.
Rangabstufung über Opazität 1.00 → 0.34.

---

## B — „Schiefer" · Rang als Tiefe

**Grundhaltung.** Haptisch und materiell. Die Zehn liegen als Stapel echter Platten
übereinander: Lichtkante oben, Schatten darunter, Rangziffern in eingelassenen
Feldern. Platz 1 liegt spürbar vorn, ist höher, heller und trägt als einziger das
Messing; nach unten werden die Platten flacher und sinken in den Grund. Priorität ist
hier nichts, was man liest, sondern etwas, das man sieht. Der Fokus-Bildschirm zeigt
die Platte im Aufsteigen aus der Tiefe, während die Geschwister oben angeschnitten
stehen bleiben. Das Duell ist eine Waage: das Paar kippt physisch nach rechts, die
gewählte Karte steigt und fängt Licht, die andere sinkt weg und wird unscharf.

**Wofür sie gut ist.** Sie wirkt sofort und sie wirkt teuer. Die Trefferflächen sind
selbsterklärend, jede Platte ist offensichtlich ein Ding, das man antippen kann —
das ist einhändig auf dem Telefon ein echter Vorteil. Die Waagen-Metapher macht aus
dem Duell eine körperliche Handlung statt einer Formularentscheidung, und genau das
ist der Moment, an dem die App ihren Kern zeigt.

**Was sie kostet.** Sie ist die aufwendigste in der Pflege: drei Schattenstufen,
zwei Lichtkanten, Materialverläufe, eingelassene Felder — jedes neue Bauteil muss
diese Grammatik mitbringen, sonst fällt es auf. Sie steht außerdem am dichtesten an
dem, was die Aufgabe ausschließt: geschichtete Karten mit Akzentfarbe *sind* die
Sprache von Produktivitäts-Software, und der Grat zwischen „Werkzeug" und
„SaaS-Oberfläche" ist schmal. Ihr größter Bruch liegt im hellen Thema: die
Tiefenstaffelung lebt davon, dass tiefer liegende Platten dunkler werden — auf
hellem Grund verblassen sie stattdessen ins Weiße, und die Aussage „Platz 10 liegt
weit hinten" wird zu „Platz 10 ist deaktiviert".

**Tokens.**

| | dunkel | hell |
|---|---|---|
| Grund | `#0F1115` + radiales Oberlicht | `#E4E6EA` |
| Platte | `linear-gradient(#262B35, #1B1F27)` | `#FFFFFF → #F3F4F7` |
| Vertiefung | `#12151A` + `inset 0 1px 3px` | `#E7E9ED` |
| Akzent | `#D6A441` Messing (+ `#F0C368`) | `#9E7118` |

Lichtkante `inset 0 1px 0 rgba(255,255,255,.085)`, Schattenstufen `--sh-1/2/3`,
Radius 20 / 15 / 10. Schrift `-apple-system` mit `-.017em` bis `-.038em` Laufweite,
Ziffern in `ui-monospace`. Rangabstufung über Opazität **und** Schattentiefe.

---

## C — „Atem" · fast nichts

**Grundhaltung.** Radikale Reduktion. Keine Linie, keine Fläche, kein Rahmen, kein
Schatten — nur Text auf Schwarz. Die Rangfolge steckt vollständig in der Typografie:
Platz 1 steht bei 21 px in vollem Weiß, Platz 10 bei 14,5 px und 26 % Deckkraft. Man
liest die Ordnung, bevor man die Ziffern sieht. Alles Maschinelle — Zahlen, Zustände,
Daten — steht in einer schmalen Monospace mit weiter Laufweite am Rand und mischt
sich nie unter den Inhalt. Bewegung ist das einzige Ornament: der eben berührte Punkt
bekommt eine Akzent-Haarlinie, die nach rechts ausläuft; im Fokus steht der Titel noch
als Geist dort, wo er in der Liste stand; im Duell zieht eine Kante am rechten Rand
und das Verlorene verblasst auf 20 %.

**Wofür sie gut ist.** Sie passt am genauesten zu dem, was tenfold verspricht: ein
stilles, privates Werkzeug ohne jede Aufforderung. Sie ist die billigste in der
Pflege — es gibt fast nichts, das brechen kann — und die schnellste. Der Duell-Bildschirm
ist in dieser Fassung der beste der drei: zwei Sätze, ein „oder", eine Kante, sonst
nichts. Die Tick-Leiste für „7 von etwa 22" gibt der App einen Instrumentencharakter,
der zum Thema passt.

**Was sie kostet.** Sie hat keine Reserve. Sobald mehr Zustände dazukommen — Anhänge,
Wiedervorlagen, Konflikte aus dem Merge — gibt es keine zweite Ebene, auf der man sie
unterbringen könnte, ohne die Haltung zu brechen; alles landet in derselben Mono-Zeile.
Sie zeigt außerdem am wenigsten: Fortschritt ist eine Bruchzahl, kein Bild, und ein
Fokus-Bildschirm mit drei Teilzielen sieht aus wie einer mit dreißig. Und sie ist die
kälteste — was bei „Verhältnis zu Anna klären" auch als Distanz gelesen werden kann.

**Tokens.**

| | dunkel | hell |
|---|---|---|
| Grund | `#070709` | `#FBFBF9` |
| Schrift | `#F2F2EF` | `#101012` |
| Akzent | `#7FA8BF` Eis | `#2E6A88` |

Opazitätsleiter `1 / .70 / .46 / .28 / .16` als einziges Hierarchiemittel.
Radius **0**, Schatten **0**, Rahmen **0**. Inhalt in `-apple-system`,
alles Metrische in `ui-monospace` bei 9,5 px und `.24em` Laufweite.
Satzspiegel 28 px.

---

## Empfehlung

**A („Register") als Basis** — mit zwei Anleihen:

- die **Monospace-Ziffern und Tick-Leiste aus C** für alles Metrische
  (Zähler, Fälligkeiten, Duell-Fortschritt). A benutzt dafür heute Kapitälchen;
  Mono ist an dieser Stelle sachlicher und trennt Maschine von Mensch sauberer.
- die **Kipp-Geste aus B** für das Duell. Die Waage ist die beste Idee der drei
  Entwürfe; sie funktioniert auch ohne Material, wenn statt der Platten die
  Textblöcke kippen — A zeigt das bereits ansatzweise.

Begründung: Die Aufgabe verlangt einen ernsten, ruhigen, persönlichen Ton und
ausdrücklich *kein* Produktivitäts-SaaS. A ist die einzige Richtung, die diesen Ton
nicht nur behauptet, sondern strukturell erzwingt — sie hat schlicht kein Bauteil,
mit dem man versehentlich ein Dashboard bauen könnte. Sie ist außerdem die einzige,
die im hellen Thema vollständig trägt, und tenfold ist eine App, die über Jahre und
bei Tageslicht benutzt wird, nicht nur abends. B ist der stärkste erste Eindruck,
aber der teuerste Weg und der mit dem größten Abrutschrisiko in genau die Optik, die
ausgeschlossen wurde; ihre Tiefenstaffelung überlebt das helle Thema nicht. C ist die
sauberste Haltung, aber sie hat zu wenig Reserve für eine App, die einen Baum
beliebiger Tiefe, Merge-Konflikte und Statusvielfalt darstellen muss.

Wenn stattdessen der erste Eindruck über alles geht — Screenshots, Vorführung,
App-Store —, dann B, aber mit der Auflage, das helle Thema neu zu denken
(Tiefe dort über Kontrast statt über Helligkeit) und die Kartensprache diszipliniert
zu halten.

---

## Offene Punkte und Unsicherheiten

- **Kontrast der Rangabstufung.** Alle drei Richtungen kodieren den Rang unter
  anderem über Deckkraft; Platz 9/10 landet bei 0,26–0,42 und reißt damit die
  WCAG-Grenze von 4,5:1 deutlich. Vor der Umsetzung braucht es einen Boden (etwa
  55 %) und die restliche Abstufung muss über Schriftgröße und Abstand laufen —
  in C ist das ohnehin schon der Haupt-Träger, in A und B nicht.
- **Brotkrume auf dem Fokus-Bildschirm.** Platz 3 ist ein Wurzelknoten, seine
  Vorfahrenkette besteht deshalb nur aus „Die Zehn". Wie sich die Krume bei fünf
  oder sechs Ebenen verhält — kürzen, mittig auslassen, seitlich scrollen — ist in
  keinem Entwurf entschieden. Auf dem Blatt-Bildschirm ist ersatzweise eine
  dreistufige Kette gezeigt.
- **Nur ein Bewegungsmoment pro Bildschirm ist darstellbar.** Gezeigt sind der
  Zwischenzustand des Wischens und die Aufblendung beim Hineinzoomen. Nicht gezeigt:
  das Zurückwandern beim Verlassen der Ebene, das Nachrücken der Liste nach einem
  Duell, das Verschwinden eines erledigten Blatts. Diese drei sind für das Gefühl der
  App vermutlich genauso wichtig und lassen sich erst am laufenden Prototyp beurteilen.
- **Nicht dargestellt:** Anlegen und Bearbeiten (Tastatur offen, halbe Höhe),
  Suche, Entsperren/Tresor, Export, leerer Zustand am ersten Tag. Besonders der
  erste Tag — zehn leere Zeilen — entscheidet über den Eindruck und fehlt hier.
- **Systemschrift-Abhängigkeit.** Alle drei Entwürfe wurden gegen die
  Apple-Schriftkette beurteilt (New York, SF Pro, SF Mono). Auf anderen Plattformen
  verschiebt sich die Anmutung, bei A am stärksten. Wenn tenfold plattformübergreifend
  gleich aussehen soll, wäre eine eingebettete Schrift nötig — was der Vorgabe
  „offline, keine geladene Schrift" nur widerspricht, wenn sie mitausgeliefert wird
  statt geladen zu werden.
