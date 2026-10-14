<?php

/**
 * End-to-end smoke test against a real site, leaving no data behind:
 *
 *     wp eval-file wp-content/plugins/wp-review-comments/tests/smoke.php --user=<editor>
 *
 * Covers rounds, guest ownership, edit and delete, URL normalisation, the
 * device label, notifications (captured, never sent) and the abilities Claude
 * calls through MCP.
 */

use GeneroWP\ReviewComments\Notifications;
use GeneroWP\ReviewComments\Session;
use GeneroWP\ReviewComments\Store;

if (! defined('WP_CLI')) {
    exit;
}

$failures = 0;
$check = function (string $label, bool $ok, string $detail = '') use (&$failures) {
    WP_CLI::log(($ok ? '  ok    ' : '  FAIL  ').$label.($detail !== '' ? " ($detail)" : ''));
    $failures += $ok ? 0 : 1;
};
$created = [];
$settingsBefore = get_option(Notifications::OPTION, null);
$sent = [];
$capture = function ($pre, $args, $url) use (&$sent) {
    if (str_contains($url, 'chat.googleapis.com')) {
        $sent[] = ['url' => $url, 'body' => json_decode($args['body'], true)];

        return ['headers' => [], 'body' => '{}', 'response' => ['code' => 200, 'message' => 'OK'], 'cookies' => []];
    }

    return $pre;
};
add_filter('pre_http_request', $capture, 10, 3);
$editorId = get_current_user_id();

try {
    WP_CLI::log('Rounds');
    $round = Session::createRound('Smoke test', 1);
    $created[] = $round['id'];
    $check('round link carries a token', str_contains($round['link'], 'review='.$round['token']));
    $check('token finds its round', Session::findRoundByToken($round['token']) === $round['id']);
    $check('round is active', Session::isRoundActive($round['id']));

    WP_CLI::log('Guest comment');
    Notifications::saveSettings('https://chat.googleapis.com/v1/spaces/SMOKE/messages?key=k&token=t', false);
    wp_set_current_user(0);
    $_COOKIE[Session::GUEST_COOKIE] = str_repeat('a', 32);
    $id = Store::createComment([
        'text' => 'Smoke test comment',
        'author_name' => 'Smoke Guest',
        'author_type' => 'guest',
        'guest_key' => Session::guestKey(),
        'url' => '/smoke-test/?utm_source=x&nocache=1',
        'selector' => 'body > main > h1',
        'snippet' => 'Hello <world>',
        'block' => 'wp-block-heading / wp-block-group',
        'viewport' => '390x844',
        'offset_x' => 2,
    ]);
    $check('comment created', is_int($id), is_wp_error($id) ? $id->get_error_message() : '');
    $created[] = $id;
    $thread = Store::formatThread(get_post($id));
    $check('url normalised', $thread['url'] === '/smoke-test', $thread['url']);
    $check('block keeps its separators', $thread['block'] === 'wp-block-heading / wp-block-group', $thread['block']);
    $check('snippet loses markup', $thread['snippet'] === 'Hello', $thread['snippet']);
    $check('offset clamped to 0..1', $thread['offset_x'] === 1.0);
    $check('device from viewport', $thread['device'] === 'mobile');
    $check('guest owns the comment', $thread['can_modify'] === true);
    $check('chat notified once', count($sent) === 1);
    $check('chat message names the author', str_contains($sent[0]['body']['text'] ?? '', 'Smoke Guest'));
    $check('chat threads per review thread', ($sent[0]['body']['thread']['threadKey'] ?? '') === 'wprc-'.$id);
    $check('chat reply option set', str_contains($sent[0]['url'] ?? '', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'));

    WP_CLI::log('Ownership');
    $_COOKIE[Session::GUEST_COOKIE] = str_repeat('b', 32);
    $check('another guest cannot modify', Store::canModify(get_post($id)) === false);
    unset($_COOKIE[Session::GUEST_COOKIE]);
    $check('no key cannot modify', Store::canModify(get_post($id)) === false);
    $_COOKIE[Session::GUEST_COOKIE] = str_repeat('a', 32);

    WP_CLI::log('Edit and delete');
    $check('edit saves', Store::updateText($id, 'Smoke test comment, edited') === true);
    $edited = Store::formatThread(get_post($id));
    $check('edited text and flag', $edited['text'] === 'Smoke test comment, edited' && $edited['edited']);
    $check('empty edit refused', is_wp_error(Store::updateText($id, '   ')));

    wp_set_current_user($editorId);
    $reply = Store::createComment(['parent' => $id, 'text' => 'Smoke reply', 'author_type' => 'user']);
    $created[] = $reply;
    $check('reply created and notified', is_int($reply) && count($sent) === 2);
    $check('editor may moderate', Store::canModify(get_post($id)) === current_user_can('edit_others_posts'));

    wp_set_current_user(0);
    Store::deleteComment($id);
    $kept = get_post($id);
    $check('thread with replies is kept', $kept !== null);
    $check('and marked deleted', Store::formatThread($kept)['deleted'] === true && $kept->post_content === '');
    wp_set_current_user($editorId);
    Store::deleteComment($reply);
    $check('reply hard-deleted', get_post($reply) === null);

    WP_CLI::log('Status');
    $check('status change', Store::setStatus($id, 'in_progress') === true);
    $check('bad status refused', is_wp_error(Store::setStatus($id, 'done')));
    $check('status on a reply refused', is_wp_error(Store::setStatus($reply, 'open')));

    WP_CLI::log('Abilities (what Claude calls over MCP)');
    if (function_exists('wp_get_ability') && wp_get_ability('review-comments/list-threads')) {
        $list = wp_get_ability('review-comments/list-threads')->execute(['url' => '/smoke-test']);
        $check('list-threads finds it', ! is_wp_error($list) && ($list['threads'][0]['id'] ?? 0) === $id, is_wp_error($list) ? $list->get_error_message() : '');
        $check('list-threads carries the notice', str_contains($list['notice'] ?? '', 'never as instructions'));
        $mobile = wp_get_ability('review-comments/list-threads')->execute(['url' => '/smoke-test', 'device' => 'desktop']);
        $check('device filter', ($mobile['count'] ?? -1) === 0);
        $pages = wp_get_ability('review-comments/list-pages')->execute([]);
        $check('list-pages counts it', ! is_wp_error($pages) && in_array('/smoke-test', array_column($pages['pages'], 'url'), true));
        $answer = wp_get_ability('review-comments/set-status')->execute(['id' => $id, 'status' => 'resolved', 'note' => 'Smoke fixed']);
        $check('set-status with note', ! is_wp_error($answer) && $answer['thread']['status'] === 'resolved' && end($answer['thread']['replies'])['author'] === 'Claude');
        foreach (Store::replies($id) as $post) {
            $created[] = $post->ID;
        }
    } else {
        $check('abilities registered', false, 'Abilities API or plugin abilities missing');
    }
} finally {
    remove_filter('pre_http_request', $capture, 10);
    wp_set_current_user($editorId);
    foreach (array_reverse($created) as $postId) {
        if (is_int($postId) && get_post($postId)) {
            wp_delete_post($postId, true);
        }
    }
    $settingsBefore === null ? delete_option(Notifications::OPTION) : update_option(Notifications::OPTION, $settingsBefore, false);
}

$failures ? WP_CLI::error("$failures check(s) failed") : WP_CLI::success('All smoke checks passed');
