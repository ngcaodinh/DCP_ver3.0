// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title CommitteeGovernance
 * @author DCP Engineering Team
 * @notice Ghi nhận quyết định và quản lý năm ghế của Ủy ban Điều hành bằng chữ ký EIP-712.
 * @dev Contract không giữ tài sản. Mọi chữ ký được kiểm tra trực tiếp với EOA hoặc smart account ERC-1271.
 */
contract CommitteeGovernance is EIP712 {
    /// @notice Vai trò của một địa chỉ trong Ủy ban Điều hành.
    enum SeatRole {
        None,
        Chair,
        Member
    }

    /// @notice Loại quyết định nghiệp vụ được ghi nhận trên chuỗi.
    enum DecisionKind {
        Disbursement,
        Arbitration
    }

    /**
     * @notice Chữ ký kèm dữ liệu chống phát lại của người đang giữ ghế.
     * @param signer Địa chỉ ghế đã tạo chữ ký.
     * @param nonce Nonce không tuần tự, duy nhất trong bitmap của signer.
     * @param deadline Thời điểm cuối cùng chữ ký còn hiệu lực.
     * @param signature Chữ ký ECDSA hoặc chữ ký tương thích ERC-1271.
     */
    struct Signature {
        address signer;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    /**
     * @notice Đề xuất thay một địa chỉ ghế sau thời gian chờ bắt buộc.
     * @param oldSeat Địa chỉ ghế đương nhiệm cần thay.
     * @param newSeat Địa chỉ mới sẽ tiếp quản ghế.
     * @param role Vai trò được chuyển giao.
     * @param effectiveAt Thời điểm sớm nhất đề xuất được thực thi.
     * @param expiresAt Thời điểm cuối cùng đề xuất còn được thực thi.
     * @param executed Đánh dấu đề xuất đã được thực thi hay chưa.
     * @param proposedAtEpoch Phiên bản roster đã phê duyệt đề xuất.
     */
    struct SeatChangeProposal {
        address oldSeat;
        uint40 effectiveAt;
        uint40 expiresAt;
        SeatRole role;
        bool executed;
        address newSeat;
        uint64 proposedAtEpoch;
    }

    /// @dev EIP-712 type hash buộc chữ ký quyết định vào toàn bộ nội dung nghiệp vụ.
    bytes32 private constant _VOTE_TYPEHASH =
        keccak256(
            "Vote(uint8 kind,bytes32 subjectId,bool approved,bytes32 reasonHash,uint64 committeeEpoch,uint256 nonce,uint256 deadline)"
        );

    /// @dev EIP-712 type hash buộc chữ ký thay ghế vào đúng địa chỉ cũ, địa chỉ mới và vai trò.
    bytes32 private constant _SEAT_CHANGE_TYPEHASH =
        keccak256(
            "SeatChange(address oldSeat,address newSeat,uint8 role,uint64 committeeEpoch,uint256 nonce,uint256 deadline)"
        );

    /// @dev EIP-712 type hash cho thao tác dừng hoặc mở lại contract bằng ngưỡng 3/5 ghế.
    bytes32 private constant _PAUSE_TYPEHASH =
        keccak256(
            "EmergencyPause(bool shouldPause,uint40 pauseContext,uint64 committeeEpoch,uint64 pauseSequence,uint256 nonce,uint256 deadline)"
        );

    /// @dev Số lượng ghế cố định; để private vì giá trị đã thể hiện trực tiếp trong ABI address[5].
    uint256 private constant _SEAT_COUNT = 5;

    /// @dev Số chữ ký ghế tối thiểu; để private nhằm không sinh getter và method selector dư thừa.
    uint256 private constant _SEAT_CHANGE_APPROVALS = 3;

    /// @dev Số chữ ký Thành viên tối thiểu; private để không sinh getter và method selector dư thừa.
    uint256 private constant _REQUIRED_MEMBER_VOTES = 2;

    /// @dev Thời gian chờ bắt buộc; private để không sinh getter và method selector dư thừa.
    uint256 private constant _SEAT_CHANGE_DELAY = 3 days;

    /// @dev Khoảng thời gian đề xuất còn thực thi được sau khi kết thúc timelock.
    uint256 private constant _SEAT_CHANGE_EXECUTION_WINDOW = 7 days;

    /// @dev Thời gian pause tối đa cho mỗi lần 3/5 ghế phê duyệt.
    uint256 private constant _MAX_PAUSE_DURATION = 14 days;

    /// @dev Recovery Chair cần toàn bộ bốn chữ ký Member còn lại để chống takeover khi Chair mất khóa.
    uint256 private constant _CHAIR_RECOVERY_APPROVALS = 4;

    /// @notice Địa chỉ có quyền nạp năm ghế đúng một lần khi khởi tạo hệ thống.
    address public immutable bootstrapAdmin;

    /// @notice Ánh xạ địa chỉ tới vai trò ghế hiện tại.
    mapping(address seat => SeatRole role) public seatOf;

    /// @notice Danh sách năm địa chỉ ghế hiện tại.
    address[5] public seatList;

    /// @notice Đánh dấu năm ghế ban đầu đã được nạp và cửa bootstrap đã khoá vĩnh viễn.
    bool public seatsBootstrapped;

    /// @notice Phiên bản roster hiện tại phải được đưa vào mọi chữ ký EIP-712.
    uint64 public committeeEpoch;

    /// @notice Mốc contract tự động mở lại; bằng zero hoặc đã qua mốc này nghĩa là không pause.
    uint40 public pausedUntil;

    /// @notice Số thứ tự tăng sau mỗi lần pause, gia hạn hoặc mở lại sớm.
    uint64 public pauseSequence;

    /// @notice Đánh dấu khóa quyết định đã được ghi để ngăn ghi trùng.
    mapping(bytes32 decisionKey => bool isRecorded) public decisionRecorded;

    /// @notice Bitmap nonce không tuần tự cho phép mỗi ghế ký nhiều nghiệp vụ song song.
    mapping(address signer => mapping(uint248 wordPosition => uint256 bitmap))
        public nonceBitmap;

    /// @notice Tổng số đề xuất thay ghế đã được tạo.
    uint256 public seatChangeProposalCount;

    /// @notice Thông tin đề xuất thay ghế theo mã tăng dần từ một.
    mapping(uint256 proposalId => SeatChangeProposal proposal)
        private _seatChangeProposals;

    /// @notice Năm ghế đã được nạp trước đó nên không thể bootstrap lần nữa.
    error SeatsAlreadyBootstrapped();

    /// @notice Người gọi không phải địa chỉ bootstrap admin đã cấu hình khi deploy.
    error NotBootstrapAdmin();

    /// @notice Năm ghế chưa được bootstrap nên chưa thể thực hiện nghiệp vụ quản trị.
    error SeatsNotBootstrapped();

    /// @notice Địa chỉ đầu vào bằng địa chỉ zero.
    error InvalidAddress();

    /// @notice Danh sách bootstrap không có đúng một Chủ tịch và bốn Thành viên.
    error InvalidSeatComposition();

    /// @notice Một địa chỉ xuất hiện nhiều lần trong danh sách ghế.
    error DuplicateSeat();

    /// @notice Chữ ký không hợp lệ với signer và nội dung EIP-712 tương ứng.
    error InvalidSignature();

    /// @notice Chữ ký đã quá deadline được người ký chấp thuận.
    error SignatureExpired();

    /// @notice Địa chỉ ký không giữ ghế trong Ủy ban hiện tại.
    error SignerNotSeated();

    /// @notice Một địa chỉ ký xuất hiện nhiều lần trong cùng một giao dịch.
    error DuplicateSigner();

    /// @notice Quyết định nghiệp vụ thiếu chữ ký bắt buộc của Chủ tịch.
    error ChairSignatureMissing();

    /// @notice Quyết định nghiệp vụ không đủ hai chữ ký Thành viên.
    error InsufficientMemberVotes();

    /// @notice Danh sách chữ ký có ít hơn ba hoặc nhiều hơn năm phần tử.
    error InvalidSignatureCount();

    /// @notice Quyết định cùng loại và cùng subject đã được ghi trước đó.
    error DecisionAlreadyRecorded();

    /// @notice Nonce trong chữ ký đã được signer sử dụng trước đó.
    error NonceAlreadyUsed();

    /// @notice Dữ liệu thay ghế không khớp trạng thái ghế hiện tại.
    error InvalidSeatChange();

    /// @notice Không tồn tại đề xuất thay ghế với mã được cung cấp.
    error SeatChangeProposalNotFound();

    /// @notice Đề xuất thay ghế đã được thực thi trước đó.
    error SeatChangeAlreadyExecuted();

    /// @notice Đề xuất thay ghế chưa hết thời gian chờ ba ngày.
    error SeatChangeNotReady();

    /// @notice Đề xuất thay ghế đã hết cửa sổ thực thi bảy ngày.
    error SeatChangeExpired();

    /// @notice Roster hiện tại đã khác roster phê duyệt đề xuất thay ghế.
    error SeatChangeEpochMismatch();

    /// @notice Thay Chair không có chữ ký Chair và chưa đủ bốn chữ ký Member recovery.
    error InsufficientChairRecoveryApprovals();

    /// @notice Thao tác quản trị đang bị dừng tạm thời.
    error GovernancePaused();

    /// @notice Contract hiện không ở trạng thái pause nên không cần mở lại.
    error GovernanceNotPaused();

    /// @notice Mốc pause mới không kéo dài hơn mốc hiện tại.
    error PauseNotExtended();

    /// @notice Ghi nhận năm ghế ban đầu được nạp thành công.
    event SeatsBootstrapped(
        address[5] seats,
        SeatRole[5] roles
    );

    /// @notice Ghi nhận một quyết định nghiệp vụ đã đạt ngưỡng chữ ký.
    event DecisionRecorded(
        DecisionKind indexed kind,
        bytes32 indexed subjectId,
        bool approved,
        address[] voters,
        bytes32 reasonHash
    );

    /// @notice Ghi nhận đề xuất thay ghế đã đạt ba chữ ký và bắt đầu thời gian chờ.
    event SeatChangeProposed(
        uint256 indexed proposalId,
        address indexed oldSeat,
        address indexed newSeat,
        address[] approvers,
        uint256 effectiveAt,
        uint256 expiresAt,
        uint64 committeeEpoch
    );

    /// @notice Ghi nhận đề xuất thay ghế đã được thực thi sau thời gian chờ.
    event SeatChangeExecuted(
        uint256 indexed proposalId,
        address indexed oldSeat,
        address indexed newSeat
    );

    /// @notice Ghi nhận thay đổi trạng thái pause có thời hạn của quản trị.
    event GovernancePauseUpdated(
        bool indexed isPaused,
        uint40 pausedUntil,
        uint64 pauseSequence
    );

    /**
     * @notice Chỉ cho phép bootstrap admin đã cấu hình nạp năm ghế ban đầu.
     * @dev Modifier chỉ bảo vệ cửa bootstrap một lần; sau bootstrap admin không có quyền quản trị nào khác.
     */
    modifier onlyBootstrapAdmin() {
        if (msg.sender != bootstrapAdmin) revert NotBootstrapAdmin();
        _;
    }

    /**
     * @notice Chặn thao tác quản trị trong thời gian pause; hết pausedUntil sẽ tự mở mà không cần giao dịch.
     * @dev So sánh trực tiếp timestamp giúp trạng thái hiệu lực tự hết hạn dù storage vẫn giữ mốc cũ.
     */
    modifier whenNotPaused() {
        if (block.timestamp < pausedUntil) revert GovernancePaused();
        _;
    }

    /**
     * @notice Khởi tạo miền EIP-712 và địa chỉ duy nhất được phép nạp năm ghế ban đầu.
     * @dev Constructor cố ý non-payable vì contract không giữ tài sản và không có đường rút native token.
     * @param bootstrapAdminAddress Địa chỉ admin thực hiện bootstrap đúng một lần.
     */
    constructor(
        address bootstrapAdminAddress
    ) EIP712("CommitteeGovernance", "1") {
        if (bootstrapAdminAddress == address(0)) revert InvalidAddress();
        bootstrapAdmin = bootstrapAdminAddress;
    }

    /**
     * @notice Nạp đúng một Chủ tịch và bốn Thành viên rồi khoá vĩnh viễn quyền bootstrap.
     * @dev Fixed-size arrays bảo đảm ABI luôn nhận đúng năm phần tử; modifier tách biệt access control khỏi validation.
     * @param seats Năm địa chỉ ví đã được đối chiếu ngoài chuỗi.
     * @param roles Vai trò tương ứng với từng địa chỉ trong seats.
     */
    function bootstrapSeats(
        address[5] calldata seats,
        SeatRole[5] calldata roles
    ) external onlyBootstrapAdmin {
        if (seatsBootstrapped) revert SeatsAlreadyBootstrapped();

        uint256 seatCount = _SEAT_COUNT;
        uint256 chairCount;
        uint256 memberCount;

        for (uint256 i; i < seatCount; ) {
            address seat = seats[i];
            SeatRole role = roles[i];

            if (seat == address(0)) revert InvalidAddress();
            if (role == SeatRole.Chair) {
                unchecked {
                    ++chairCount;
                }
            } else if (role == SeatRole.Member) {
                unchecked {
                    ++memberCount;
                }
            } else {
                revert InvalidSeatComposition();
            }

            for (uint256 j; j < i; ) {
                if (seats[j] == seat) revert DuplicateSeat();
                unchecked {
                    ++j;
                }
            }
            unchecked {
                ++i;
            }
        }

        if (chairCount != 1) revert InvalidSeatComposition();
        if (memberCount != 4) revert InvalidSeatComposition();

        // Chỉ khoá cửa bootstrap sau khi toàn bộ đầu vào đã vượt qua kiểm tra bất biến 1/4.
        seatsBootstrapped = true;
        committeeEpoch = 1;
        for (uint256 i; i < seatCount; ) {
            address seat = seats[i];
            seatOf[seat] = roles[i];
            seatList[i] = seat;
            unchecked {
                ++i;
            }
        }

        emit SeatsBootstrapped(seats, roles);
    }

    /**
     * @notice Dừng tối đa 14 ngày hoặc mở lại sớm các thao tác quản trị bằng ít nhất ba chữ ký ghế.
     * @dev Backend ký pauseContext = pausedUntil khi pause còn hiệu lực, ngược lại ký 0. Nếu giao dịch vượt qua
     * mốc pausedUntil trước khi được khai thác, digest sẽ đổi và backend phải tạo lại chữ ký với pauseContext = 0.
     * @param shouldPause True để đặt lại mốc pause 14 ngày, false để mở lại sớm.
     * @param signatures Danh sách chữ ký EIP-712 của các ghế đương nhiệm.
     */
    function setPaused(
        bool shouldPause,
        Signature[] calldata signatures
    ) external {
        _requireSeatsBootstrapped();
        uint256 signatureCount = signatures.length;
        if (signatureCount < _SEAT_CHANGE_APPROVALS) {
            revert InvalidSignatureCount();
        }
        if (signatureCount > _SEAT_COUNT) revert InvalidSignatureCount();

        if (!shouldPause) {
            if (block.timestamp >= pausedUntil) {
                revert GovernanceNotPaused();
            }
        }

        _verifyPauseSignatures(shouldPause, signatures);
        uint40 updatedPausedUntil;
        if (shouldPause) {
            uint40 newPausedUntil = uint40(
                block.timestamp + _MAX_PAUSE_DURATION
            );
            if (newPausedUntil <= pausedUntil) revert PauseNotExtended();
            pausedUntil = newPausedUntil;
            updatedPausedUntil = newPausedUntil;
        } else {
            delete pausedUntil;
        }

        uint64 newPauseSequence = pauseSequence + 1;
        pauseSequence = newPauseSequence;
        emit GovernancePauseUpdated(
            shouldPause,
            updatedPausedUntil,
            newPauseSequence
        );
    }

    /**
     * @notice Cho biết pause có còn hiệu lực tại timestamp hiện tại hay không.
     * @dev Giá trị tự chuyển false khi đạt pausedUntil mà không cần giao dịch ghi storage.
     * @return isPaused True khi block.timestamp vẫn nhỏ hơn pausedUntil.
     */
    function paused() external view returns (bool isPaused) {
        isPaused = block.timestamp < pausedUntil;
    }

    /**
     * @notice Kiểm chữ ký Chủ tịch cùng ít nhất hai Thành viên rồi ghi quyết định duy nhất.
     * @dev Người gọi chỉ là relayer; quyền ghi được xác lập bởi chữ ký ghế hợp lệ, không dựa vào msg.sender.
     * @param kind Loại quyết định giải ngân hoặc phán quyết dự án.
     * @param subjectId Mã định danh nghiệp vụ cần đối soát.
     * @param approved Kết quả mà tất cả signer trong giao dịch đã ký.
     * @param reasonHash Hash của lý do gốc được hiển thị cho người ký.
     * @param signatures Danh sách chữ ký EIP-712 của các ghế đương nhiệm.
     */
    function recordDecision(
        DecisionKind kind,
        bytes32 subjectId,
        bool approved,
        bytes32 reasonHash,
        Signature[] calldata signatures
    ) external whenNotPaused {
        _requireSeatsBootstrapped();
        uint256 signatureCount = signatures.length;
        if (signatureCount < _SEAT_CHANGE_APPROVALS) {
            revert InvalidSignatureCount();
        }
        if (signatureCount > _SEAT_COUNT) revert InvalidSignatureCount();

        bytes32 decisionKey = keccak256(abi.encode(kind, subjectId));
        if (decisionRecorded[decisionKey]) {
            revert DecisionAlreadyRecorded();
        }

        (
            address[] memory voters,
            bool hasChairSignature,
            uint256 memberVotes
        ) = _verifyDecisionSignatures(
                kind,
                subjectId,
                approved,
                reasonHash,
                signatures
            );

        if (!hasChairSignature) revert ChairSignatureMissing();
        if (memberVotes < _REQUIRED_MEMBER_VOTES) {
            revert InsufficientMemberVotes();
        }

        decisionRecorded[decisionKey] = true;

        emit DecisionRecorded(
            kind,
            subjectId,
            approved,
            voters,
            reasonHash
        );
    }

    /**
     * @notice Tạo đề xuất thay ghế khi có ít nhất ba chữ ký của các ghế đương nhiệm.
     * @dev Thay Chair cần 3/5 có Chair đương nhiệm, hoặc đủ ba chữ ký Member khi Chair mất khóa hay không hợp tác.
     * @param oldSeat Địa chỉ ghế cần được thay thế.
     * @param newSeat Địa chỉ mới chưa giữ ghế nào.
     * @param role Vai trò phải khớp với oldSeat và sẽ được chuyển sang newSeat.
     * @param signatures Danh sách chữ ký EIP-712 của các ghế đương nhiệm.
     * @return proposalId Mã đề xuất tăng dần dùng để thực thi sau thời gian chờ.
     */
    function proposeSeatChange(
        address oldSeat,
        address newSeat,
        SeatRole role,
        Signature[] calldata signatures
    ) external whenNotPaused returns (uint256 proposalId) {
        _requireSeatsBootstrapped();
        uint256 signatureCount = signatures.length;
        if (signatureCount < _SEAT_CHANGE_APPROVALS) {
            revert InvalidSignatureCount();
        }
        if (signatureCount > _SEAT_COUNT) revert InvalidSignatureCount();
        _validateSeatChange(oldSeat, newSeat, role);

        (
            address[] memory approvers,
            bool hasChairSignature
        ) = _verifySeatChangeSignatures(oldSeat, newSeat, role, signatures);
        if (role == SeatRole.Chair) {
            if (!hasChairSignature) {
                if (signatureCount < _CHAIR_RECOVERY_APPROVALS) {
                    revert InsufficientChairRecoveryApprovals();
                }
            }
        }

        proposalId = ++seatChangeProposalCount;
        uint64 currentCommitteeEpoch = committeeEpoch;
        uint256 effectiveAt = block.timestamp + _SEAT_CHANGE_DELAY;
        uint256 expiresAt = effectiveAt + _SEAT_CHANGE_EXECUTION_WINDOW;
        _seatChangeProposals[proposalId] = SeatChangeProposal({
            oldSeat: oldSeat,
            // Timestamp còn rất xa giới hạn uint40 và hai mốc được pack cùng oldSeat trong một slot.
            effectiveAt: uint40(effectiveAt),
            expiresAt: uint40(expiresAt),
            role: role,
            executed: false,
            newSeat: newSeat,
            proposedAtEpoch: currentCommitteeEpoch
        });

        emit SeatChangeProposed(
            proposalId,
            oldSeat,
            newSeat,
            approvers,
            effectiveAt,
            expiresAt,
            currentCommitteeEpoch
        );
    }

    /**
     * @notice Thực thi đề xuất trong cửa sổ bảy ngày sau timelock nếu roster chưa thay đổi.
     * @dev Pause không kéo dài expiresAt; proposal hết hạn trong lúc pause phải được đề xuất và ký lại. Thực thi
     * thành công tăng epoch nên mọi proposal khác cùng epoch trở thành stale và cũng phải đề xuất lại.
     * @param proposalId Mã đề xuất đã được ghi bởi proposeSeatChange.
     */
    function executeSeatChange(
        uint256 proposalId
    ) external whenNotPaused {
        _requireSeatsBootstrapped();

        SeatChangeProposal storage proposal = _seatChangeProposals[proposalId];
        address oldSeat = proposal.oldSeat;
        address newSeat = proposal.newSeat;
        SeatRole role = proposal.role;
        uint40 effectiveAt = proposal.effectiveAt;
        uint40 expiresAt = proposal.expiresAt;

        if (oldSeat == address(0)) revert SeatChangeProposalNotFound();
        if (proposal.executed) revert SeatChangeAlreadyExecuted();
        if (proposal.proposedAtEpoch != committeeEpoch) {
            revert SeatChangeEpochMismatch();
        }
        if (block.timestamp < effectiveAt) {
            revert SeatChangeNotReady();
        }
        if (block.timestamp > expiresAt) revert SeatChangeExpired();

        _validateSeatChange(oldSeat, newSeat, role);

        // Đánh dấu trước khi cập nhật ghế để giữ thứ tự effects rõ ràng và ngăn thực thi lại.
        proposal.executed = true;
        committeeEpoch += 1;
        delete seatOf[oldSeat];
        seatOf[newSeat] = role;

        for (uint256 i; i < _SEAT_COUNT; ) {
            if (seatList[i] == oldSeat) {
                seatList[i] = newSeat;
                break;
            }
            unchecked {
                ++i;
            }
        }

        emit SeatChangeExecuted(proposalId, oldSeat, newSeat);
    }

    /**
     * @notice Đọc toàn bộ đề xuất thay ghế dưới dạng một struct duy nhất.
     * @dev Trả struct giúp consumer giữ các field cùng một miền dữ liệu và tận dụng layout hai storage slot.
     * @param proposalId Mã đề xuất cần truy vấn.
     * @return proposal Đề xuất gồm hai địa chỉ, vai trò, mốc hiệu lực/hết hạn, epoch và trạng thái thực thi.
     */
    function seatChangeProposals(
        uint256 proposalId
    )
        external
        view
        returns (SeatChangeProposal memory proposal)
    {
        proposal = _seatChangeProposals[proposalId];
    }

    /**
     * @notice Trả về năm địa chỉ ghế hiện tại cùng vai trò tương ứng.
     * @dev Hàm revert trước bootstrap để không trả về năm địa chỉ zero gây hiểu nhầm cho indexer.
     * @return seats Năm địa chỉ ghế theo thứ tự bootstrap và các lần thay thế.
     * @return roles Vai trò hiện tại tương ứng với từng địa chỉ.
     */
    function getSeats()
        external
        view
        returns (address[5] memory seats, SeatRole[5] memory roles)
    {
        _requireSeatsBootstrapped();

        for (uint256 i; i < _SEAT_COUNT; ) {
            address seat = seatList[i];
            seats[i] = seat;
            roles[i] = seatOf[seat];
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Kiểm toàn bộ chữ ký quyết định và tiêu thụ nonce nếu giao dịch thành công.
     * @dev Mọi thay đổi nonce tự rollback nếu một chữ ký hoặc ngưỡng biểu quyết phía sau không hợp lệ.
     */
    function _verifyDecisionSignatures(
        DecisionKind kind,
        bytes32 subjectId,
        bool approved,
        bytes32 reasonHash,
        Signature[] calldata signatures
    ) private returns (address[] memory voters, bool hasChair, uint256 memberVotes) {
        uint256 signatureCount = signatures.length;
        uint64 currentCommitteeEpoch = committeeEpoch;
        voters = new address[](signatureCount);

        for (uint256 i; i < signatureCount; ) {
            Signature calldata submittedSignature = signatures[i];
            address signer = submittedSignature.signer;
            SeatRole signerRole = seatOf[signer];

            _validateSigner(signatures, i, signer, signerRole);

            bytes32 structHash = keccak256(
                abi.encode(
                    _VOTE_TYPEHASH,
                    uint8(kind),
                    subjectId,
                    approved,
                    reasonHash,
                    currentCommitteeEpoch,
                    submittedSignature.nonce,
                    submittedSignature.deadline
                )
            );
            _verifyAndConsumeSignature(submittedSignature, structHash);

            voters[i] = signer;
            if (signerRole == SeatRole.Chair) {
                hasChair = true;
            } else {
                unchecked {
                    ++memberVotes;
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Kiểm toàn bộ chữ ký thay ghế và tiêu thụ nonce nếu giao dịch thành công.
     * @dev Đề xuất thay ghế dùng ngưỡng ba ghế đương nhiệm, không trao quyền đặc biệt cho backend.
     */
    function _verifySeatChangeSignatures(
        address oldSeat,
        address newSeat,
        SeatRole role,
        Signature[] calldata signatures
    ) private returns (address[] memory approvers, bool hasChair) {
        uint256 signatureCount = signatures.length;
        uint64 currentCommitteeEpoch = committeeEpoch;
        approvers = new address[](signatureCount);

        for (uint256 i; i < signatureCount; ) {
            Signature calldata submittedSignature = signatures[i];
            address signer = submittedSignature.signer;
            SeatRole signerRole = seatOf[signer];

            _validateSigner(signatures, i, signer, signerRole);

            bytes32 structHash = keccak256(
                abi.encode(
                    _SEAT_CHANGE_TYPEHASH,
                    oldSeat,
                    newSeat,
                    uint8(role),
                    currentCommitteeEpoch,
                    submittedSignature.nonce,
                    submittedSignature.deadline
                )
            );
            _verifyAndConsumeSignature(submittedSignature, structHash);
            approvers[i] = signer;
            if (signerRole == SeatRole.Chair) hasChair = true;
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Kiểm ngưỡng 3/5 chữ ký cho thao tác dừng khẩn cấp hoặc mở lại contract.
     * @dev Context vẫn cần cùng sequence vì auto-expiry không ghi storage hay tăng sequence; nó vô hiệu chữ ký
     * chưa submit của chu kỳ vừa hết hạn bằng cách đổi context từ pausedUntil về zero.
     */
    function _verifyPauseSignatures(
        bool shouldPause,
        Signature[] calldata signatures
    ) private {
        uint256 signatureCount = signatures.length;
        uint64 currentCommitteeEpoch = committeeEpoch;
        uint64 currentPauseSequence = pauseSequence;
        uint40 currentPausedUntil = pausedUntil;
        uint40 pauseContext;
        if (block.timestamp < currentPausedUntil) {
            pauseContext = currentPausedUntil;
        }

        for (uint256 i; i < signatureCount; ) {
            Signature calldata submittedSignature = signatures[i];
            address signer = submittedSignature.signer;

            _validateSigner(signatures, i, signer, seatOf[signer]);

            bytes32 structHash = keccak256(
                abi.encode(
                    _PAUSE_TYPEHASH,
                    shouldPause,
                    pauseContext,
                    currentCommitteeEpoch,
                    currentPauseSequence,
                    submittedSignature.nonce,
                    submittedSignature.deadline
                )
            );
            _verifyAndConsumeSignature(submittedSignature, structHash);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Kiểm signer đang giữ ghế và chưa xuất hiện trước đó trong cùng danh sách.
     * @dev So sánh tối đa năm ghế nên vòng lặp bậc hai có chi phí nhỏ và tránh thêm storage tạm.
     */
    function _validateSigner(
        Signature[] calldata signatures,
        uint256 signerIndex,
        address signer,
        SeatRole signerRole
    ) private pure {
        if (signer == address(0)) revert InvalidAddress();
        if (signerRole == SeatRole.None) revert SignerNotSeated();

        for (uint256 i; i < signerIndex; ) {
            if (signatures[i].signer == signer) revert DuplicateSigner();
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Kiểm nonce bitmap, deadline và chữ ký EIP-712 rồi đánh dấu nonce đã dùng.
     * @dev SignatureChecker hỗ trợ đồng thời ví EOA và smart account triển khai ERC-1271.
     */
    function _verifyAndConsumeSignature(
        Signature calldata submittedSignature,
        bytes32 structHash
    ) private {
        address signer = submittedSignature.signer;
        uint256 nonce = submittedSignature.nonce;
        uint248 wordPosition = uint248(nonce >> 8);
        uint256 nonceBit = uint256(1) << uint8(nonce);
        uint256 currentBitmap = nonceBitmap[signer][wordPosition];
        if ((currentBitmap & nonceBit) != 0) revert NonceAlreadyUsed();
        if (block.timestamp > submittedSignature.deadline) {
            revert SignatureExpired();
        }

        bytes32 digest = _hashTypedDataV4(structHash);
        if (
            !SignatureChecker.isValidSignatureNowCalldata(
                signer,
                digest,
                submittedSignature.signature
            )
        ) {
            revert InvalidSignature();
        }

        nonceBitmap[signer][wordPosition] = currentBitmap | nonceBit;
    }

    /**
     * @notice Kiểm địa chỉ cũ đang giữ đúng vai trò và địa chỉ mới chưa có ghế.
     * @dev Tách từng điều kiện để lỗi địa chỉ zero rõ ràng và tránh biểu thức boolean nhiều toán hạng.
     */
    function _validateSeatChange(
        address oldSeat,
        address newSeat,
        SeatRole role
    ) private view {
        if (oldSeat == address(0)) revert InvalidAddress();
        if (newSeat == address(0)) revert InvalidAddress();
        if (role == SeatRole.None) revert InvalidSeatChange();
        if (oldSeat == newSeat) revert InvalidSeatChange();

        // Hai key khác nhau bắt buộc cần hai SLOAD; mỗi kết quả được cache đúng một lần để không đọc lặp.
        SeatRole oldSeatRole = seatOf[oldSeat];
        SeatRole newSeatRole = seatOf[newSeat];
        if (oldSeatRole != role) revert InvalidSeatChange();
        if (newSeatRole != SeatRole.None) revert InvalidSeatChange();
    }

    /**
     * @notice Chặn nghiệp vụ quản trị trước khi năm ghế ban đầu được nạp đầy đủ.
     * @dev Mọi quyết định và thay ghế đều phụ thuộc roster đã được bootstrap đúng một lần.
     */
    function _requireSeatsBootstrapped() private view {
        if (!seatsBootstrapped) revert SeatsNotBootstrapped();
    }
}
