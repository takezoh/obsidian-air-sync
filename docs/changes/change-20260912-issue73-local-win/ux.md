---
change: change-20260912-issue73-local-win
role: ux
user_goals:
- goal-select-local-preference
- goal-resolve-proven-edit-conflict
- goal-preserve-uncertain-versions
- goal-keep-bidirectional-sync
- goal-protect-edits-and-compound-conflicts
flows:
- id: F-001
  goal_refs:
  - goal-select-local-preference
  experience_contract_refs:
  - exp-settings
  acceptance_scenario_refs:
  - UAC-001
- id: F-002
  goal_refs:
  - goal-keep-bidirectional-sync
  experience_contract_refs:
  - exp-ordinary-sync
  acceptance_scenario_refs:
  - UAC-002
  - UAC-003
  - UAC-004
  - UAC-005
  - UAC-014
- id: F-003
  goal_refs:
  - goal-resolve-proven-edit-conflict
  experience_contract_refs:
  - exp-proven-conflict
  acceptance_scenario_refs:
  - UAC-006
- id: F-004
  goal_refs:
  - goal-preserve-uncertain-versions
  experience_contract_refs:
  - exp-uncertain
  acceptance_scenario_refs:
  - UAC-007
  - UAC-008
  - UAC-015
- id: F-005
  goal_refs:
  - goal-protect-edits-and-compound-conflicts
  experience_contract_refs:
  - exp-edit-delete
  acceptance_scenario_refs:
  - UAC-009
- id: F-006
  goal_refs:
  - goal-protect-edits-and-compound-conflicts
  experience_contract_refs:
  - exp-compound
  acceptance_scenario_refs:
  - UAC-010
  - UAC-016
- id: F-007
  goal_refs:
  - goal-select-local-preference
  experience_contract_refs:
  - exp-compatibility
  acceptance_scenario_refs:
  - UAC-011
  - UAC-012
  - UAC-013
  - UAC-017
  - UAC-018
experience_contracts:
- id: exp-settings
  scenario_refs:
  - UAC-001
- id: exp-ordinary-sync
  scenario_refs:
  - UAC-002
  - UAC-003
  - UAC-004
  - UAC-005
  - UAC-014
- id: exp-proven-conflict
  scenario_refs:
  - UAC-006
- id: exp-uncertain
  scenario_refs:
  - UAC-007
  - UAC-008
  - UAC-015
- id: exp-edit-delete
  scenario_refs:
  - UAC-009
- id: exp-compound
  scenario_refs:
  - UAC-010
  - UAC-016
- id: exp-compatibility
  scenario_refs:
  - UAC-011
  - UAC-012
  - UAC-013
  - UAC-017
  - UAC-018
decision_points:
- id: DP-CONFLICT-SCOPE
  decision_key: conflict-scope
  contract_effect: normative
  answer_status: answered
  selected_option_ref: OPT-CONFLICT-ONLY
- id: DP-CONTENT-PROOF
  decision_key: content-proof-unavailable
  contract_effect: normative
  answer_status: answered
  selected_option_ref: OPT-PRESERVE-BOTH-NO-PROMPT
- id: DP-POLICY-ENTRY
  decision_key: policy-entry
  contract_effect: default
  answer_status: answered
  selected_option_ref: OPT-PEER-STRATEGY
- id: DP-POLICY-NAME
  decision_key: policy-name
  contract_effect: default
  answer_status: answered
  selected_option_ref: OPT-PREFER-LOCAL
- id: DP-UNCERTAIN-PLACEMENT
  decision_key: uncertain-collision-placement
  contract_effect: default
  answer_status: defaulted
  selected_option_ref: OPT-LOCAL-ORIGINAL-REMOTE-PRESERVED
dispositions:
- decision_input_ref: recovery:unknown-startup-evidence-stale
  disposition: stale startup index を根拠から除外し、直接確認済みのコード、テスト、文書、履歴で続行した。
  contract_refs:
  - exp-settings
  - exp-ordinary-sync
  - exp-proven-conflict
  - exp-uncertain
  - exp-edit-delete
  - exp-compound
  - exp-compatibility
- decision_input_ref: explore:ALT-LAYERED-PREFERENCE
  disposition: peer strategy の承認により不採用。Specify で復活させない。
  contract_refs:
  - exp-settings
- decision_input_ref: explore:rejected-improvement-run-workflow
  disposition: Like air の自動運転制約に反するため不採用。専用実行入口を追加しない。
  contract_refs:
  - exp-settings
  - exp-proven-conflict
  - exp-uncertain
---

# Prefer local — Specify UX plan

## Goal

<!-- anchor: goal-select-local-preference -->
### Prefer local の意味を理解して選ぶ

Air Sync の利用者は、競合動作の既存の選択肢で Auto merge、Duplicate と並ぶ第三の一般方針として Prefer local を選べる。これは同期全体を一方向化するモードではなく、競合と判断された場合だけ作用する。

<!-- anchor: goal-select-local-preference.success-observation -->
選択前に、内容から両側編集を証明できる競合ではローカル版を採用し、安全に判断できない衝突では入力を求めず両版を残すことを確認できる。

<!-- anchor: goal-resolve-proven-edit-conflict -->
### 証明済みの両側編集競合をローカル版で解決する

共通の最終同期内容からローカル版とリモート版の双方が編集されたことを内容から証明できる場合、利用者の選好どおりローカル内容を共有結果にする。

<!-- anchor: goal-resolve-proven-edit-conflict.success-observation -->
同期後、両側の元ファイルは同期前のローカル内容で一致し、通常の競合コピーはなく、リモートだけの変更も混入していない。

<!-- anchor: goal-preserve-uncertain-versions -->
### 不確実な衝突で両版を回収可能にする

共通履歴がない場合、または履歴があってもローカル変更を内容から証明できない場合は、Prefer local という名称だけを理由に一方を破棄しない。

<!-- anchor: goal-preserve-uncertain-versions.success-observation -->
回答待ちなく同期が終わり、ローカル版は元の場所、同期前のリモート版は保全版として両側から識別して開ける。保全できなければ同期は成功として終わらず、同期前に回収できた両内容が破壊的に置換されない。

<!-- anchor: goal-keep-bidirectional-sync -->
### 通常の双方向同期を維持する

Prefer local を選択していても、競合ではない片側編集と片側新規は従来どおり変更がある側から反対側へ届く。

<!-- anchor: goal-keep-bidirectional-sync.success-observation -->
ローカル編集、リモート編集、ローカル新規、リモート新規のいずれも反対側で同じ内容を開ける。

<!-- anchor: goal-protect-edits-and-compound-conflicts -->
### 編集版と複合競合の別版を保護する

編集対削除では場所の選好より唯一の編集版を優先し、rename または同一性衝突を伴う競合では必要な別版の回収可能性を維持する。

<!-- anchor: goal-protect-edits-and-compound-conflicts.success-observation -->
編集対削除の後は編集済み内容を両側で開ける。複合競合では、保全可能なら置換結果と別内容の両方を開け、保全不能なら元内容を失った状態を成功として示さない。

Modeled on: 現行の Auto merge と Duplicate が保存済み方針に従い、入力待ちなく競合を終端する体験。
Rejected: 競合ごとに利用者へ判断を求める Ask 型の体験、および通常同期までローカル方向へ固定する一方向モード。

Migration Context: 旧 Keep local は一般方針として不成立と判断されたのではなく、六つの戦略を Auto merge・Duplicate・Ask に整理した簡素化の過程で他の戦略とともに利用者向け選択肢から外れた。その後 Ask は入力待ちのない Like air の動作と両立しないため現行選択肢から外れた。今回継承するのは Auto merge、Duplicate、保存済み旧 ask の Duplicate 相当結果、通常の双方向同期、編集対削除と複合競合の保全である。置き換えるのは証明済み両側編集競合に対する local win を選べない状態だけであり、旧 Keep local の無条件上書きや Ask の対話待ちは復活させない。

## Target Users

- 複数端末で同じ vault を自動同期し、内容から証明できる両側編集競合では手元の内容を共有結果にしたい利用者。
- 古い端末や復元した vault を起動することがあり、履歴不明の状態で新しい共有内容が静かに失われることを避けたい利用者。
- デスクトップとモバイルのいずれでも、同期中に競合ごとの回答を求められたくない利用者。

## Primary Flows

<!-- anchor: f-001 -->
### F-001: Prefer local の意味を理解して選ぶ

入口は既存の競合動作設定である。利用者は pointer、keyboard、touch、または screen reader で Auto merge、Duplicate、Prefer local の選択肢へ到達する。名称と関連説明から、競合限定、証明済み両側編集でのローカル採用、不確実時の両版保全を選択前に確認する。出口では Prefer local が選択された状態を確認できる。

<!-- anchor: f-002 -->
### F-002: 通常の双方向同期を続ける

入口は Prefer local が選ばれ、競合ではない片側編集または片側新規が存在すること。出口は、変更の起点にかかわらず同期後に反対側で同じ内容を開けることである。

<!-- anchor: f-003 -->
### F-003: 証明済み両側編集競合をローカル版で解決する

入口は、共通の最終同期内容から両側が異なる内容へ編集されたことを内容から確認できる競合である。同期は入力を求めず進み、両側の元ファイルがローカル内容で一致し、通常の競合コピーが現れないことが出口となる。

<!-- anchor: f-004 -->
### F-004: 履歴不明または内容証明不能の衝突で両版を自動保全する

入口は、同じ場所に異なる内容があるものの、共通履歴がないか、ローカル変更を内容から証明できない状態である。回答必須の画面は現れない。成功時の出口ではローカル版を元の場所で、同期前のリモート版を保全版として両側から開ける。保全できない場合は失敗を確認でき、同期前に回収可能だった両内容を残したまま再同期できる。

<!-- anchor: f-005 -->
### F-005: 編集と削除の競合で編集版を保つ

入口は、前回同期後に一方で編集し、他方で同じファイルを削除した状態である。編集側がローカルでもリモートでも、同期後に両側で編集済み内容を開けることが出口となる。

<!-- anchor: f-006 -->
### F-006: 複合競合で別版を保全する

入口は rename または同一性衝突を伴い、置換で別内容が失われ得る状態である。保全可能なら置換結果と保全版の双方を開ける。保全不能なら破壊的置換を成功として完了せず、元の回収可能な内容を残す。

<!-- anchor: f-007 -->
### F-007: 既存戦略と旧 ask の互換結果を保つ

入口は Auto merge または Duplicate を選択した状態、あるいは保存済み競合戦略が旧 ask の vault をアップグレードして開くこと。出口は、Auto merge と Duplicate が従来の結果を示し、旧 ask が回答を求めず Duplicate 相当の結果を示すことである。

## Experience Contracts

<!-- anchor: exp-settings -->
### exp-settings: 方針の理解と選択

入口は競合動作設定を開いた状態、進行は名称と関連説明を modality に応じて確認すること、成功と出口は Prefer local を選択でき、その意味を選択前に確認できることである。

<!-- anchor: exp-settings.interaction-rules -->
Auto merge と Duplicate に並ぶ peer strategy として Prefer local を提示する。関連説明で「競合だけ」「内容から証明できる両側編集ではローカル版を採用」「判断不能時は両版を自動保全」を伝え、pointer、keyboard、touch、screen reader のいずれでも名称と説明の関係を確認できる。

<!-- anchor: exp-settings.invariants -->
実行ごとの専用操作、競合ごとの質問、一方向同期の設定として見せない。既存の Auto merge と Duplicate を置換または改名しない。

<!-- anchor: exp-ordinary-sync -->
### exp-ordinary-sync: 通常同期

入口は競合ではない片側変更または片側新規、成功と出口は反対側で同じ内容を開けることである。進行、失敗、回復の見え方は現行同期体験を変更しない。

<!-- anchor: exp-ordinary-sync.interaction-rules -->
ローカル編集、リモート編集、ローカル新規、リモート新規を、発生側から反対側へ届ける。

<!-- anchor: exp-ordinary-sync.invariants -->
Prefer local は競合分類後だけ作用し、通常変更を方向固定、削除、無視へ変えない。

<!-- anchor: exp-proven-conflict -->
### exp-proven-conflict: 証明済み両側編集競合

入口は共通内容からの両側編集を内容で証明できること、進行は入力待ちのない自動同期、成功と出口は両側の元ファイルがローカル内容で一致することである。通常競合コピーまたはリモート変更の混入は失敗であり、次回同期では残る現在内容を再評価できる。

<!-- anchor: exp-proven-conflict.interaction-rules -->
同期前のローカル内容を両側の元ファイルの結果にし、通常の競合コピーを作らず、リモートだけの変更を混入しない。

<!-- anchor: exp-proven-conflict.invariants -->
現在の内容による証明なしに local win を適用せず、競合処理のための回答を要求しない。

<!-- anchor: exp-uncertain -->
### exp-uncertain: 不確実な異内容衝突

入口は共通履歴がないか、古い状態・復元状態などでローカルとリモートの意図した勝者を内容から一意に判断できない異内容衝突である。進行は入力待ちのない自動処理。成功と出口はローカル版を元の場所、同期前のリモート版を保全版として両側から開けることである。保全失敗時は成功を示さず、両内容を破壊的に置換せず、残っている現在の両版を次回同期で再評価できる。

<!-- anchor: exp-uncertain.interaction-rules -->
local win を適用せず、既存 Duplicate と同じ配置で、同期前のローカル内容とリモート内容を識別して回収できる形に自動保全する。

<!-- anchor: exp-uncertain.invariants -->
共通履歴の有無だけ、更新時刻だけ、または Prefer local という名称だけで一方を破棄しない。Ask 型の入力待ちを加えない。保全完了前に破壊的置換を成功結果にしない。

<!-- anchor: exp-edit-delete -->
### exp-edit-delete: 編集対削除

入口は片側編集と反対側削除の競合、成功と出口は編集済み内容が両側に存在することである。進行、失敗、回復の見え方は現行同期体験を変更しない。

<!-- anchor: exp-edit-delete.interaction-rules -->
編集側がローカルでもリモートでも、削除より編集版を優先して両側から開ける結果にする。

<!-- anchor: exp-edit-delete.invariants -->
ローカル優先を「ローカルでの削除がリモート編集に勝つ」という場所の優先へ拡張しない。

<!-- anchor: exp-compound -->
### exp-compound: rename・同一性を伴う複合競合

入口は置換で別内容が失われ得る複合競合である。保全可能な場合の成功と出口は置換結果と保全版を開けること。保全不能時は失敗を示し、破壊的置換を成功として完了せず、元の回収可能な内容を残して再同期可能にする。進行表示は現行体験を変更しない。

<!-- anchor: exp-compound.interaction-rules -->
保全可能なら別内容を残して置換を完了する。保全不能なら元内容を残し、破壊的置換を完了しない。

<!-- anchor: exp-compound.invariants -->
証明済みの単純な edit/edit で競合コピーを省略する規則を、複合競合へ一律に広げない。保全可能なのに常に未完了で止めない。

<!-- anchor: exp-compatibility -->
### exp-compatibility: 既存方針とアップグレード互換

入口は Auto merge、Duplicate、または保存済み旧 ask のいずれかである。進行は入力待ちのない自動同期。成功と出口は従来の方針ごとの結果を確認できることである。失敗と回復の見え方は現行同期体験を変更しない。

<!-- anchor: exp-compatibility.interaction-rules -->
Auto merge は共通内容が使えるとき三者マージし、使えないときは順序づけ可能な新しい版を採用し、順序づけ不能な異内容は Duplicate 相当にする。Duplicate はローカル版を元の場所、リモート版を競合ファイルとして両側に残す。保存済み旧 ask は質問を表示せず Duplicate 相当の結果にする。

<!-- anchor: exp-compatibility.invariants -->
Prefer local の追加によって既存二戦略の選択可能性と結果を変えず、旧 ask を Prefer local へ読み替えない。

## Acceptance Scenarios

<!-- anchor: uac-001 -->
### UAC-001: Prefer local を理解して選択する
<!-- anchor: uac-001.given -->
**Given** 競合動作設定を開き、Auto merge と Duplicate の選択肢を確認できる。
<!-- anchor: uac-001.when -->
**When** Prefer local の名称と関連説明を pointer、keyboard、touch、または screen reader で確認する。
<!-- anchor: uac-001.then -->
**Then** Prefer local を選べ、競合時だけ作用し、証明済み両側編集ではローカル版を採用し、不確実時には両版を自動保全することを選択前に確認できる。
<!-- anchor: uac-001.counterexample -->
**Counterexample** 名称だけを追加して無条件にローカルが勝つと読める実装や、screen reader から名称と説明の関係が分からない実装は、安全境界を選択前に確認できないため失敗する。
**vs Legacy**: must-fail

<!-- anchor: uac-002 -->
### UAC-002: ローカルだけの編集をリモートへ届ける
<!-- anchor: uac-002.given -->
**Given** Prefer local が選ばれ、ローカル側だけで既存ファイルを編集している。
<!-- anchor: uac-002.when -->
**When** 同期が完了する。
<!-- anchor: uac-002.then -->
**Then** リモートの同じ場所でローカル編集と同じ内容を開け、競合コピーは現れない。
<!-- anchor: uac-002.counterexample -->
**Counterexample** リモートからローカルへの方向だけを残す実装は、ローカル編集をリモートへ届けないため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-003 -->
### UAC-003: リモートだけの編集をローカルへ届ける
<!-- anchor: uac-003.given -->
**Given** Prefer local が選ばれ、リモート側だけで既存ファイルを編集している。
<!-- anchor: uac-003.when -->
**When** 同期が完了する。
<!-- anchor: uac-003.then -->
**Then** ローカルの同じ場所でリモート編集と同じ内容を開け、ローカルの古い内容へ巻き戻されない。
<!-- anchor: uac-003.counterexample -->
**Counterexample** Prefer local を一方向同期として扱う実装は、リモート編集を古いローカル内容で置き換えるため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-004 -->
### UAC-004: ローカルだけの新規ファイルをリモートへ届ける
<!-- anchor: uac-004.given -->
**Given** Prefer local が選ばれ、ローカル側だけに新規ファイルがある。
<!-- anchor: uac-004.when -->
**When** 同期が完了する。
<!-- anchor: uac-004.then -->
**Then** リモート側でも同じ新規ファイルと内容を開ける。
<!-- anchor: uac-004.counterexample -->
**Counterexample** ローカル新規を無視する実装は、反対側にファイルが現れないため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-005 -->
### UAC-005: リモートだけの新規ファイルをローカルへ届ける
<!-- anchor: uac-005.given -->
**Given** Prefer local が選ばれ、リモート側だけに新規ファイルがある。
<!-- anchor: uac-005.when -->
**When** 同期が完了する。
<!-- anchor: uac-005.then -->
**Then** ローカル側でも同じ新規ファイルと内容を開ける。
<!-- anchor: uac-005.counterexample -->
**Counterexample** ローカルにないことを削除の意思と扱う実装は、リモート新規を消すため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-006 -->
### UAC-006: 証明済み両側編集をローカル版で解決する
<!-- anchor: uac-006.given -->
**Given** 共通の最終同期内容からローカル版とリモート版の双方が異なる内容へ編集されたことを内容から確認できる。
<!-- anchor: uac-006.when -->
**When** Prefer local で同期が完了する。
<!-- anchor: uac-006.then -->
**Then** 両側の元ファイルは同期前のローカル内容になり、新しい通常競合コピーはなく、リモートだけの変更は元ファイルへ混入しない。
<!-- anchor: uac-006.counterexample -->
**Counterexample** Auto merge、Duplicate、リモート優先の結果は、それぞれ混合内容、追加競合ファイル、またはリモート内容が現れるため失敗する。
**vs Legacy**: must-fail

<!-- anchor: uac-007 -->
### UAC-007: 共通履歴のない異内容衝突で両版を残す
<!-- anchor: uac-007.given -->
**Given** 古い状態の vault を持つ端末の cold start などで、同じ場所のローカル版と現在のリモート版が異なり、ファイル内容から意図した勝者を一意に判断できない。
<!-- anchor: uac-007.when -->
**When** Prefer local で同期が完了する。
<!-- anchor: uac-007.then -->
**Then** 回答を求められず、ローカル版は両側の元の場所、同期前のリモート版は両側の保全版として識別して開ける。
<!-- anchor: uac-007.counterexample -->
**Counterexample** 古いローカル版だけでリモートを置換する実装は現在のリモート内容を回収不能にし、Ask を表示する実装は入力なしで完了しないため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-008 -->
### UAC-008: 内容から勝者を証明できない衝突で両版を残す
<!-- anchor: uac-008.given -->
**Given** 古い状態または復元した端末のローカル内容と現在のリモート内容が異なり、見えているファイル内容から利用者が意図した勝者を一意に判断できない。
<!-- anchor: uac-008.when -->
**When** Prefer local で同期が完了する。
<!-- anchor: uac-008.then -->
**Then** 回答を求められず、ローカル版は両側の元の場所、同期前のリモート版は両側の保全版として識別して開ける。
<!-- anchor: uac-008.counterexample -->
**Counterexample** 見えている内容だけでは勝者不明なのに local win を適用する実装は、同期前のリモート内容を回収不能にするため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-009 -->
### UAC-009: 編集対削除では編集版を保つ
<!-- anchor: uac-009.given -->
**Given** 前回同期後に一方でファイルを編集し、他方で同じファイルを削除している。
<!-- anchor: uac-009.when -->
**When** Prefer local で同期が完了する。
<!-- anchor: uac-009.then -->
**Then** 編集側がローカルかリモートかにかかわらず、両側で編集済み内容を開ける。
<!-- anchor: uac-009.counterexample -->
**Counterexample** ローカルという場所を常に優先する実装は、ローカル側で削除した場合にリモートの唯一の編集版を消すため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-010 -->
### UAC-010: 保全可能な複合競合を完了する
<!-- anchor: uac-010.given -->
**Given** rename または同一性衝突を伴い、置換前の別内容を保全できる。
<!-- anchor: uac-010.when -->
**When** Prefer local で同期が完了する。
<!-- anchor: uac-010.then -->
**Then** 置換結果と、置換前の別内容を残した保全版の双方を開ける。
<!-- anchor: uac-010.counterexample -->
**Counterexample** 保全可能でも常に未完了にして置換結果を提供しない実装は、成功結果を開けないため失敗する。競合コピー不要と一律に扱う実装も別内容を開けないため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-011 -->
### UAC-011: Auto merge の三者マージを維持する
<!-- anchor: uac-011.given -->
**Given** Prefer local 追加後も Auto merge を選択し、共通内容からマージ可能な両側編集競合がある。
<!-- anchor: uac-011.when -->
**When** 同期が完了する。
<!-- anchor: uac-011.then -->
**Then** Auto merge を引き続き選択でき、元ファイルに両側変更を含むマージ結果が現れる。
<!-- anchor: uac-011.counterexample -->
**Counterexample** Auto merge を local win と同じ結果へ変える実装は、両側変更を含むマージ結果が現れないため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-012 -->
### UAC-012: Duplicate の選択と結果を維持する
<!-- anchor: uac-012.given -->
**Given** Prefer local 追加後も Duplicate を選択し、両側編集競合がある。
<!-- anchor: uac-012.when -->
**When** 同期が完了する。
<!-- anchor: uac-012.then -->
**Then** Duplicate を選択でき、ローカル版が元の場所に残り、リモート版を回収できる競合ファイルが両側に現れる。
<!-- anchor: uac-012.counterexample -->
**Counterexample** Duplicate を削除する実装や競合ファイルを作らない実装は、選択肢またはリモート版の回収可能性を失うため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-013 -->
### UAC-013: 保存済み旧 ask を Duplicate 相当として扱う
<!-- anchor: uac-013.given -->
**Given** 保存済み競合戦略が旧 ask の vault に両側編集競合がある。
<!-- anchor: uac-013.when -->
**When** アップグレード後の同期が完了する。
<!-- anchor: uac-013.then -->
**Then** 回答を求められず、ローカル版が元の場所に残り、リモート版を回収できる競合ファイルが現れる。
<!-- anchor: uac-013.counterexample -->
**Counterexample** 旧 ask を Prefer local へ読み替える実装は競合ファイルを作らず、旧 ask の質問を復活させる実装は入力なしで完了しないため失敗する。
**vs Legacy**: must-fail

<!-- anchor: uac-014 -->
### UAC-014: 両側が同内容なら余分な保全版を作らない
<!-- anchor: uac-014.given -->
**Given** Prefer local が選ばれ、同じ場所のローカル版とリモート版を開くと同じ内容である。
<!-- anchor: uac-014.when -->
**When** 同期が完了する。
<!-- anchor: uac-014.then -->
**Then** 両側の元ファイルで同じ内容を開け、新しい保全版や競合コピーは現れない。
<!-- anchor: uac-014.counterexample -->
**Counterexample** 内容が同じでも競合として複製する実装は、同期後に余分なファイルが現れるため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-015 -->
### UAC-015: 不確実衝突の保全失敗で両版を破壊しない
<!-- anchor: uac-015.given -->
**Given** 同じ場所に勝者を一意に判断できないローカル内容とリモート内容があり、保全版を最後まで保存できない。
<!-- anchor: uac-015.when -->
**When** Prefer local で同期を試みる。
<!-- anchor: uac-015.then -->
**Then** 同期は成功として示されず、同期前に開けたローカル内容とリモート内容は破壊的に置換されず、残る現在の両版で再同期できる。
<!-- anchor: uac-015.counterexample -->
**Counterexample** 保全書込みに失敗した後でリモートを古いローカル内容に置換する実装は、同期前のリモート内容を開けず、再同期時にも評価できないため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-016 -->
### UAC-016: 保全不能な複合競合を破壊的に完了しない
<!-- anchor: uac-016.given -->
**Given** rename または同一性衝突を伴い、置換前の別内容を保全できない。
<!-- anchor: uac-016.when -->
**When** Prefer local で同期を試みる。
<!-- anchor: uac-016.then -->
**Then** 同期は成功として示されず、破壊的置換は完了せず、元の回収可能な内容を開け、残る現在内容で再同期できる。
<!-- anchor: uac-016.counterexample -->
**Counterexample** 保全不能でも置換を完了する実装は元内容を開けなくなるため失敗し、保全可能時まで常に止める実装は UAC-010 に失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-017 -->
### UAC-017: Auto merge の順序づけ可能な fallback を維持する
<!-- anchor: uac-017.given -->
**Given** Auto merge が選ばれ、共通内容からマージできないが、一方を新しい版として判断できる異内容競合がある。
<!-- anchor: uac-017.when -->
**When** 同期が完了する。
<!-- anchor: uac-017.then -->
**Then** 両側の元ファイルで新しい版の内容を開ける。
<!-- anchor: uac-017.counterexample -->
**Counterexample** Auto merge の fallback を常に local win に変える実装は、リモート版が新しい場合に古いローカル内容が現れるため失敗する。
**vs Legacy**: must-pass

<!-- anchor: uac-018 -->
### UAC-018: Auto merge の順序づけ不能な fallback を維持する
<!-- anchor: uac-018.given -->
**Given** Auto merge が選ばれ、共通内容からマージできず、異なる両版の新旧も判断できない。
<!-- anchor: uac-018.when -->
**When** 同期が完了する。
<!-- anchor: uac-018.then -->
**Then** ローカル版は元の場所、リモート版は競合ファイルとして両側から開ける。
<!-- anchor: uac-018.counterexample -->
**Counterexample** 順序づけ不能時も常にローカル版だけを残す実装は、リモート内容を回収できないため失敗する。
**vs Legacy**: must-pass

## Decision State

<!-- requirements-decisions:start -->
Selected alternative: ALT-PEER-STRATEGY

<!-- anchor: dp-conflict-scope -->
### Decision DP-CONFLICT-SCOPE: OPT-CONFLICT-ONLY
Prefer local は競合として分類された後だけ作用する。

<!-- anchor: dp-content-proof -->
### Decision DP-CONTENT-PROOF: OPT-PRESERVE-BOTH-NO-PROMPT
内容で勝者を証明できない衝突では両版を入力待ちなく保全する。

<!-- anchor: dp-policy-entry -->
### Decision DP-POLICY-ENTRY: OPT-PEER-STRATEGY
Prefer local は既存の競合動作選択に並ぶ第三の一般方針とする。

<!-- anchor: dp-policy-name -->
### Decision DP-POLICY-NAME: OPT-PREFER-LOCAL
名称は Prefer local とし、安全条件を関連説明で明示する。

<!-- anchor: dp-uncertain-placement -->
### Decision DP-UNCERTAIN-PLACEMENT: OPT-LOCAL-ORIGINAL-REMOTE-PRESERVED
不確実衝突の成功時は既存 Duplicate と同じく、ローカル版を元の場所に残し、同期前のリモート版を保全版として両側に残す。新しい設定や操作は加えない。
<!-- requirements-decisions:end -->

## Edge Cases

- 両側の内容が同じ場合は、不要な保全版を増やさず同じ内容を維持する（UAC-014）。
- 古い端末や復元 vault で勝者を内容から一意に判断できない場合は、時刻や名前だけで local win しない（UAC-007、UAC-008）。
- 不確実衝突の保全に失敗した場合は、同期前の両内容を破壊せず成功を示さない（UAC-015）。
- 片側だけの新規ファイルを Prefer local の名目で削除または無視しない（UAC-004、UAC-005）。
- 複合競合は保全可能時の成功と保全不能時の安全な失敗を区別する（UAC-010、UAC-016）。
- Auto merge の三者マージ、順序づけ可能な採用、順序づけ不能な Duplicate 相当結果をすべて維持する（UAC-011、UAC-017、UAC-018）。

## Assumptions

「Prefer local」という短い名称と関連説明の組合せで、利用者が競合限定と不確実時の両版保全を理解できると仮定する。代表利用者が通常同期、証明済み両側編集、不確実衝突の結果を説明できるかで検証する。誤解が残る場合は提示表現を再検討するが、確定済みの結果契約は変更しない。

## Open Questions

Specify を止める未解決の product decision はない。不確実衝突の両版配置は既存 Duplicate と同じ結果に固定した。startup evidence の古さは根拠から除外し、直接確認済みのコード、テスト、文書、履歴だけを用いた。
