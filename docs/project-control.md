# Practio Projektsteuerung

Die Projektsteuerung ist direkt in das bestehende Dashboard integriert. Es gibt kein zweites Frontend.

## Bereiche

- **Übersicht:** Daily Focus, Blocker und Aufgaben pro Teammitglied
- **Masterplan:** Produkt-/MVP-Ziel, Module, Risiken, offene Fragen, Milestones und versionierte Planstände
- **Task Board:** Backlog, Diese Woche, In Arbeit, Review, Blockiert und Fertig
- **Team:** Rollen und Verantwortungen für Ole und Henry
- **AI Review:** Diff-Prüfung gegen Akzeptanzkriterien, Qualität, Sicherheit und UX

## Datenhaltung

1. `supabase/schema.sql` im Supabase SQL Editor ausführen.
2. Die aktualisierte `server/epikur-dashboard.nginx` aktivieren; sie leitet den gesamten Pfad `/api/`
   an den Node-Service weiter. Vor dem Reload immer `nginx -t` ausführen.
3. Auf dem Server `SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` setzen.
4. Ohne Service-Role-Key nutzt der Server `server/data/project-control.json`.
5. Ist auch die Project-Control-API nicht erreichbar, bleibt das Browser-Autosave aktiv.

Die Service-Role darf niemals in `index.html`, Local Storage oder an den Browser ausgeliefert werden.

## Server-Konfiguration

Siehe `server/.env.example`. Relevante Variablen:

- `GITHUB_TOKEN`: optional; ohne Token werden öffentliche Repositories anonym abgefragt.
- `CLAUDE_REVIEW_MODEL`: optional, Standard `sonnet`.
- `PRACTIO_AI_REVIEW_MODE=mock`: erzwingt den deterministischen Review-Fallback.
- `SUPABASE_SERVICE_ROLE_KEY`: aktiviert die serverseitige Supabase-Persistenz.

Alle GitHub-Synchronisationen und AI-Reviews werden in `activity_log` sowie zusätzlich in
`server/data/project-control-activity.jsonl` protokolliert.

## Merge-Schutz

Es existiert keine Merge-API. Der bestehende Code-Chat blockiert direkte Pushes auf `main` oder `master`
und pusht ausschließlich den bereits aktiven Feature-Branch. Pull Request, Checks, manuelle Freigabe,
Merge und Produktion bleiben getrennte, bewusste Schritte.

## Workflow

`Plan -> Task -> Branch -> Commit -> AI Review -> Pull Request -> Checks -> manuelle Freigabe -> Merge`

Ein Task gilt in der Oberfläche nur dann als mergebereit, wenn Pull Request, Checks und Reviewstatus
passen. Dieser Status löst keinen Merge aus.
