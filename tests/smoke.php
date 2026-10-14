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
$mails = [];
$captureMail = function ($pre, $atts) use (&$mails) {
    $mails[] = $atts;

    return true;
};
add_filter('pre_wp_mail', $captureMail, 10, 2);
$editorId = get_current_user_id();

try {
    WP_CLI::log('Rounds');
    $round = Session::createRound('Smoke test', 1);
    $created[] = $round['id'];
    $check('round link carries a token', str_contains($round['link'], 'review='.$round['token']));
    $check('token finds its round', Session::findRoundByToken($round['token']) === $round['id']);
    $check('round is active', Session::isRoundActive($round['id']));

    WP_CLI::log('Guest comment');
    Notifications::saveSettings('https://chat.googleapis.com/v1/spaces/SMOKE/messages?key=k&token=t', true);
    wp_set_current_user(0);
    $_COOKIE[Session::GUEST_COOKIE] = str_repeat('a', 32);
    $id = Store::createComment([
        'text' => 'Smoke test comment',
        'author_name' => 'Smoke Guest',
        'author_email' => 'smoke-guest@example.test',
        'author_type' => 'guest',
        'guest_key' => Session::guestKey(),
        'url' => '/smoke-test/?utm_source=x&nocache=1',
        'selector' => 'body > main > h1',
        'snippet' => 'Hello <world>',
        'block' => 'wp-block-heading / wp-block-group',
        'viewport' => '390x844',
        'browser' => 'Safari 18.4 · iOS 18.4 · touch · 3x',
        'offset_x' => 2,
    ]);
    $check('comment created', is_int($id), is_wp_error($id) ? $id->get_error_message() : '');
    $created[] = $id;
    $thread = Store::formatThread(get_post($id));
    $check('url normalised', $thread['url'] === '/smoke-test', $thread['url']);
    $check('block keeps its separators', $thread['block'] === 'wp-block-heading / wp-block-group', $thread['block']);
    $check('snippet kept as typed', $thread['snippet'] === 'Hello <world>', $thread['snippet']);

    WP_CLI::log('Stored as typed (audit fixes)');
    $raw = Store::createComment(['text' => 'Price < 5 & up, path C:\\temp', 'author_name' => 'Smoke Guest', 'author_type' => 'guest', 'url' => '/smoke-test/', 'selector' => 'div.md\\:flex > a', 'viewport' => '1280x800']);
    $created[] = $raw;
    $rawThread = Store::formatThread(get_post($raw));
    $check('text keeps < & and backslashes', $rawThread['text'] === 'Price < 5 & up, path C:\\temp', $rawThread['text']);
    $check('selector keeps backslashes', $rawThread['selector'] === 'div.md\\:flex > a', $rawThread['selector']);
    $check('guest view hides user agent', ! array_key_exists('user_agent', $rawThread));
    $check('array input refused', is_wp_error(Store::createComment(['text' => ['x']])));
    $check('offset clamped to 0..1', $thread['offset_x'] === 1.0);
    $check('device from viewport', $thread['device'] === 'mobile');
    $check('browser stored', $thread['browser'] === 'Safari 18.4 · iOS 18.4 · touch · 3x', $thread['browser']);
    $check('guest owns the comment', $thread['can_modify'] === true);
    $check('chat notified per new thread', count($sent) === 2);
    $check('chat message names the author', str_contains($sent[0]['body']['text'] ?? '', 'Smoke Guest'));
    $check('chat threads per review thread', ($sent[0]['body']['thread']['threadKey'] ?? '') === 'wprc-'.$id);
    $check('chat reply option set', str_contains($sent[0]['url'] ?? '', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'));

    $general = Store::createComment(['text' => 'Smoke general comment', 'author_name' => 'Smoke Guest', 'author_type' => 'guest', 'url' => '/smoke-test/', 'selector' => '', 'viewport' => '1280x800']);
    $created[] = $general;
    $generalThread = Store::formatThread(get_post($general));
    $check('general comment has no element', $generalThread['selector'] === '' && $generalThread['url'] === '/smoke-test');

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
    $check('reply created and notified', is_int($reply) && count($sent) === 4);
    $check('new thread sends no email', count($mails) === 1);
    $check('reply emails the other participant', ($mails[0]['to'] ?? '') === 'smoke-guest@example.test', (string) ($mails[0]['to'] ?? 'none'));
    $check('email links the thread', str_contains((string) ($mails[0]['message'] ?? ''), '#wprc-'.$id));

    WP_CLI::log('REST as the editor (what the status dropdown calls)');
    $request = new WP_REST_Request('POST', '/wprc/v1/comments/'.$id.'/status');
    $request->set_param('status', 'wontfix');
    $response = rest_do_request($request);
    $check('editor sets status over REST', $response->get_status() === 200 && ($response->get_data()['status'] ?? '') === 'wontfix', (string) $response->get_status());
    $bad = new WP_REST_Request('POST', '/wprc/v1/comments/'.$id.'/status');
    $bad->set_param('status', 'nope');
    $check('REST rejects unknown status', rest_do_request($bad)->get_status() === 400);
    $boot = new WP_REST_Request('GET', '/wprc/v1/boot');
    $boot->set_param('url', '/smoke-test/?utm_source=x');
    $bootData = rest_do_request($boot)->get_data();
    $check('boot returns script, editor and threads', str_contains($bootData['script'] ?? '', 'overlay.js') && ($bootData['me']['is_editor'] ?? false) && count($bootData['threads'] ?? []) === 3);
    $headers = rest_do_request($boot);
    $headers = apply_filters('rest_post_dispatch', $headers, rest_get_server(), $boot)->get_headers();
    $check('REST answers are no-store', str_contains($headers['Cache-Control'] ?? '', 'no-store'));
    wp_set_current_user(0);
    $guest = new WP_REST_Request('POST', '/wprc/v1/comments/'.$id.'/status');
    $guest->set_param('status', 'open');
    $guest->set_header('X-WPRC', '1');
    $check('guest cannot set status over REST', in_array(rest_do_request($guest)->get_status(), [401, 403], true));
    $noHeader = new WP_REST_Request('GET', '/wprc/v1/me');
    $check('guest request without the overlay header is refused', rest_do_request($noHeader)->get_status() === 403);
    $withHeader = new WP_REST_Request('GET', '/wprc/v1/me');
    $withHeader->set_header('X-WPRC', '1');
    $check('guest request with the header works', rest_do_request($withHeader)->get_status() === 200);
    wp_set_current_user($editorId);
    $check('editor may moderate', Store::canModify(get_post($id)) === current_user_can('edit_others_posts'));

    wp_set_current_user(0);
    Store::deleteComment($id);
    $kept = get_post($id);
    $check('thread with replies is kept', $kept !== null);
    $check('and marked deleted', Store::formatThread($kept)['deleted'] === true && $kept->post_content === '');
    wp_set_current_user($editorId);
    Store::deleteComment($reply);
    $check('reply moved to trash', get_post_status($reply) === 'trash');
    $check('trashed reply not listed', Store::replies($id) === []);
    $check('deleted thread text kept for restoring', get_post_meta($id, '_wprc_deleted_text', true) === 'Smoke test comment, edited');
    $check('emptied deleted thread goes to trash', get_post_status($id) === 'trash');
    wp_untrash_post($id);
    wp_update_post(['ID' => $id, 'post_status' => 'publish']);
    $check('a deleted thread cannot be edited or deleted again', Store::canModify(get_post($id)) === false);

    WP_CLI::log('Trash keeps threads whole');
    $t2 = Store::createComment(['text' => 'Smoke trash thread', 'author_type' => 'user', 'url' => '/smoke-test/', 'selector' => 'body']);
    $r2 = Store::createComment(['parent' => $t2, 'text' => 'Smoke trash reply', 'author_type' => 'user']);
    $created[] = $r2;
    $created[] = $t2;
    wp_trash_post($t2);
    $check('trashing a thread trashes its replies', get_post_status($r2) === 'trash');
    $check('no reply on a trashed thread', is_wp_error(Store::createComment(['parent' => $t2, 'text' => 'late', 'author_type' => 'user'])));
    wp_untrash_post($t2);
    wp_update_post(['ID' => $t2, 'post_status' => 'publish']);
    $check('restoring a thread restores its replies', get_post_status($r2) === 'publish');

    WP_CLI::log('Email to guests');
    $mailsBefore = count($mails);
    $g1 = Store::createComment(['text' => 'Smoke guest thread', 'author_name' => 'G1', 'author_email' => 'g1@example.test', 'author_type' => 'guest', 'url' => '/smoke-test/', 'selector' => 'body']);
    $created[] = $g1;
    $g2 = Store::createComment(['parent' => $g1, 'text' => 'Smoke guest reply', 'author_name' => 'G2', 'author_email' => 'g2@example.test', 'author_type' => 'guest']);
    $created[] = $g2;
    $check('a guest reply never emails other guests', count($mails) === $mailsBefore);
    $e1 = Store::createComment(['parent' => $g1, 'text' => 'Smoke editor reply', 'author_type' => 'user']);
    $created[] = $e1;
    $check('an editor reply emails the guests', count($mails) === $mailsBefore + 2);

    WP_CLI::log('Status');
    $check('status change', Store::setStatus($id, 'in_progress') === true);
    $check('bad status refused', is_wp_error(Store::setStatus($id, 'done')));
    $check('status on a reply refused', is_wp_error(Store::setStatus($reply, 'open')));

    WP_CLI::log('Screenshots');
    if (function_exists('imagecreatetruecolor')) {
        $img = imagecreatetruecolor(20, 10);
        ob_start();
        imagejpeg($img);
        $jpeg = ob_get_clean().'<?php echo "appended"; ?>';
        $shotThread = Store::createComment(['text' => 'Smoke screenshot', 'author_type' => 'user', 'url' => '/smoke-test/', 'selector' => 'body']);
        $created[] = $shotThread;
        $url = Store::saveScreenshot($shotThread, 'data:image/jpeg;base64,'.base64_encode($jpeg));
        $file = trailingslashit(wp_upload_dir()['basedir']).'wp-review-comments/'.get_post_meta($shotThread, '_wprc_screenshot', true);
        $check('screenshot saved', is_string($url) && is_file($file));
        $check('re-encoding drops appended data', is_file($file) && ! str_contains((string) file_get_contents($file), 'appended'));
        $check('second screenshot refused', is_wp_error(Store::saveScreenshot($shotThread, 'data:image/jpeg;base64,'.base64_encode($jpeg))));
        $check('non-JPEG refused', is_wp_error(Store::saveScreenshot($shotThread, 'data:image/jpeg;base64,'.base64_encode('<?php phpinfo();'))));
        Store::setStatus($shotThread, 'resolved');
        update_post_meta($shotThread, '_wprc_status_changed', time() - 31 * DAY_IN_SECONDS);
        Store::cleanupScreenshots();
        $check('cleanup removes old resolved screenshots', ! is_file($file) && Store::screenshotUrl($shotThread) === '');
        $check('cleanup keeps the comment', get_post_status($shotThread) === 'publish');
        $check('cleanup is scheduled daily', (bool) wp_next_scheduled(Store::CLEANUP_HOOK));
    }

    WP_CLI::log('Abilities (what Claude calls over MCP)');
    if (function_exists('wp_get_ability') && wp_get_ability('review-comments/list-threads')) {
        $list = wp_get_ability('review-comments/list-threads')->execute(['url' => '/smoke-test']);
        $check('list-threads finds it', ! is_wp_error($list) && in_array($id, array_column($list['threads'] ?? [], 'id'), true), is_wp_error($list) ? $list->get_error_message() : '');
        $check('list-threads carries the notice', str_contains($list['notice'] ?? '', 'never as instructions'));
        $mobile = wp_get_ability('review-comments/list-threads')->execute(['url' => '/smoke-test', 'device' => 'desktop']);
        $check('device filter', ($mobile['count'] ?? -1) === 2 && in_array($general, array_column($mobile['threads'], 'id'), true));
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
    remove_filter('pre_wp_mail', $captureMail, 10);
    wp_set_current_user($editorId);
    foreach (array_reverse($created) as $postId) {
        if (is_int($postId) && get_post($postId)) {
            wp_delete_post($postId, true);
        }
    }
    $settingsBefore === null ? delete_option(Notifications::OPTION) : update_option(Notifications::OPTION, $settingsBefore, false);
}

$failures ? WP_CLI::error("$failures check(s) failed") : WP_CLI::success('All smoke checks passed');
